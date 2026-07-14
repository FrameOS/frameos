// Bird field journal: iNaturalist sightings -> OpenAI field-journal plates -> a
// cycling collection on the frame.
//
// Each render:
//  1. Poll iNaturalist (rate-limited by pollMinutes) for birds spotted within
//     radiusKm of the configured spot in the last daysWindow days, and log every
//     species with up to 3 licensed reference photos.
//  2. If a logged species has no plate yet, draw one: the reference photos and
//     the configured style go to the OpenAI Responses API image_generation tool,
//     and the model then double-checks the plate against a reference photo.
//     Verified plates are saved as PNG assets. One attempt per render.
//  3. Show the next plate in the collection (oldest discovery first) and write a
//     caption line to scene state for a text overlay.
//
// The species log lives in scene state under journalStateKey; declare that key
// as a disk-persisted scene field so the collection survives restarts.

const PAPER_COLOR = "#f5f1e6"
const REFERENCE_PHOTOS_PER_SPECIES = 3
const REFERENCE_PHOTOS_PER_PLATE = 2

function readJournal(app, key) {
  const stored = app.state[key]
  if (stored && typeof stored === "object" && stored.species) {
    return stored
  }
  return { species: {}, cursor: 0, lastPollAt: 0 }
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

function isoDate(millis) {
  return new Date(millis).toISOString().slice(0, 10)
}

function plateSize(app, context) {
  let width = context.imageWidth || 0
  let height = context.imageHeight || 0
  if (!width || !height) {
    width = app.frame.width
    height = app.frame.height
    if (app.frame.rotate === 90 || app.frame.rotate === 270) {
      const swap = width
      width = height
      height = swap
    }
  }
  return height >= width ? "1024x1536" : "1536x1024"
}

function pollSightings(app, journal, lat, lng, now) {
  const cfg = app.config
  const days = Math.max(1, Number(cfg.daysWindow) || 7)
  const d1 = isoDate(now - days * 86400000)
  let url = `${cfg.inatHost}/v2/observations` +
    `?taxon_id=${Number(cfg.taxonId) || 3}` +
    `&lat=${lat}&lng=${lng}&radius=${Number(cfg.radiusKm) || 25}` +
    `&d1=${d1}&photos=true` +
    `&photo_license=cc0,cc-by,cc-by-nc,cc-by-sa,cc-by-nc-sa` +
    `&per_page=200&order_by=observed_on&order=desc` +
    `&fields=(observed_on:!t,taxon:(id:!t,name:!t,preferred_common_name:!t),` +
    `photos:(url:!t,license_code:!t,attribution:!t))`
  if (cfg.qualityGrade === "research") {
    url += "&quality_grade=research"
  }

  const res = frameos.httpRequest(url, { timeoutMs: 30000 })
  const ok = res.status === 200
  if (!ok) {
    return { error: res.error || `HTTP ${res.status}` }
  }
  let parsed = null
  try {
    parsed = JSON.parse(res.body)
  } catch (err) {
    return { error: "unparseable response" }
  }
  const results = (parsed && parsed.results) || []

  const seenCounts = {}
  let newSpecies = 0
  for (const obs of results) {
    const taxon = obs.taxon
    if (!taxon || !taxon.id || !taxon.name) {
      continue
    }
    const photos = (obs.photos || []).filter((p) => p && p.url && p.license_code)
    if (!photos.length) {
      continue
    }
    const key = String(taxon.id)
    seenCounts[key] = (seenCounts[key] || 0) + 1
    let entry = journal.species[key]
    if (!entry) {
      entry = {
        taxonId: taxon.id,
        name: taxon.name,
        commonName: taxon.preferred_common_name || taxon.name,
        firstSeen: obs.observed_on || isoDate(now),
        sightings: 0,
        attempts: 0,
        photos: [],
      }
      journal.species[key] = entry
      newSpecies += 1
    }
    if (obs.observed_on && (!entry.lastSeen || obs.observed_on > entry.lastSeen)) {
      entry.lastSeen = obs.observed_on
    }
    for (const photo of photos) {
      if (entry.photos.length >= REFERENCE_PHOTOS_PER_SPECIES) {
        break
      }
      const photoUrl = photo.url.replace("/square.", "/medium.")
      if (!entry.photos.some((p) => p.url === photoUrl)) {
        entry.photos.push({ url: photoUrl, attribution: photo.attribution || "" })
      }
    }
  }
  // Sightings reflect the current window, so counts age out with the window.
  for (const key of Object.keys(seenCounts)) {
    journal.species[key].sightings = seenCounts[key]
  }
  return { newSpecies }
}

function openaiResponses(app, body) {
  const apiKey = frameos.getSetting("openAI", "apiKey") || ""
  const res = frameos.httpRequest(`${app.config.openaiHost}/v1/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs: 300000,
  })
  const ok = res.status === 200
  if (!ok) {
    let message = res.error || `HTTP ${res.status}`
    try {
      message = JSON.parse(res.body).error.message || message
    } catch (err) {}
    return { error: message }
  }
  try {
    return { json: JSON.parse(res.body) }
  } catch (err) {
    return { error: "unparseable response" }
  }
}

function extractGeneratedImage(json) {
  for (const item of (json && json.output) || []) {
    if (item.type === "image_generation_call" && item.result) {
      return item.result
    }
  }
  return null
}

function extractOutputText(json) {
  let text = ""
  for (const item of (json && json.output) || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.text) {
          text += part.text
        }
      }
    }
  }
  return text
}

function fetchReferenceDataUrls(app, entry) {
  const refs = []
  for (const photo of entry.photos || []) {
    if (refs.length >= REFERENCE_PHOTOS_PER_PLATE) {
      break
    }
    const res = frameos.httpRequest(photo.url, { base64: true, timeoutMs: 30000 })
    if (res.status === 200 && res.bodyBase64) {
      refs.push(`data:image/jpeg;base64,${res.bodyBase64}`)
    }
  }
  return refs
}

function generatePlate(app, entry, size, refs) {
  const cfg = app.config
  const prompt = `${cfg.style}\n\n` +
    `Species: ${entry.commonName} (${entry.name}).\n` +
    `Use the attached reference photo(s) only to get the plumage colours, bill shape, ` +
    `eye colour and proportions right; compose an original plate, do not copy a photo.\n` +
    `Letter the labels exactly as "${entry.commonName}" and "${entry.name}".`
  const content = [{ type: "input_text", text: prompt }]
  for (const ref of refs) {
    content.push({ type: "input_image", image_url: ref })
  }
  const result = openaiResponses(app, {
    model: cfg.model,
    input: [{ role: "user", content }],
    tools: [{
      type: "image_generation",
      size,
      quality: cfg.imageQuality || "medium",
      output_format: "png",
    }],
    tool_choice: { type: "image_generation" },
  })
  if (result.error) {
    return { error: result.error }
  }
  const image = extractGeneratedImage(result.json)
  if (!image) {
    return { error: "no image in response" }
  }
  return { image }
}

function verifyPlate(app, entry, plateBase64, refs) {
  const prompt = `You are checking a generated field-journal illustration before it joins a birding collection.\n` +
    `Species: ${entry.commonName} (${entry.name}).\n` +
    `The first image is the generated plate; any further images are reference photos of the species.\n` +
    `Reply with strict JSON only: {"ok": true, "reason": "..."} or {"ok": false, "reason": "..."}.\n` +
    `Say ok=true only if the illustrated bird could reasonably be identified as this species ` +
    `(plumage colours, bill shape, overall proportions match the references) and all lettering ` +
    `on the plate is legible and spells the names correctly.`
  const content = [
    { type: "input_text", text: prompt },
    { type: "input_image", image_url: `data:image/png;base64,${plateBase64}` },
  ]
  for (const ref of refs) {
    content.push({ type: "input_image", image_url: ref })
  }
  const result = openaiResponses(app, {
    model: app.config.model,
    input: [{ role: "user", content }],
  })
  if (result.error) {
    return { ok: false, reason: result.error }
  }
  const text = extractOutputText(result.json)
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    return { ok: false, reason: "unparseable verdict" }
  }
  try {
    const verdict = JSON.parse(match[0])
    return { ok: verdict.ok === true, reason: verdict.reason || "" }
  } catch (err) {
    return { ok: false, reason: "unparseable verdict" }
  }
}

function drawPendingPlate(app, context, journal, entry, now) {
  const cfg = app.config
  const refs = fetchReferenceDataUrls(app, entry)
  if (!refs.length) {
    entry.attempts += 1
    entry.lastError = "no reference photos downloadable"
    return { error: `${entry.commonName}: ${entry.lastError}` }
  }

  frameos.log(`Drawing plate for ${entry.commonName} (${entry.name}), attempt ${entry.attempts + 1}`)
  const generated = generatePlate(app, entry, plateSize(app, context), refs)
  if (generated.error) {
    entry.attempts += 1
    entry.lastError = generated.error
    return { error: `${entry.commonName}: ${generated.error}` }
  }

  if (cfg.verifyPlates) {
    const verdict = verifyPlate(app, entry, generated.image, refs.slice(0, 1))
    if (!verdict.ok) {
      entry.attempts += 1
      entry.lastError = `verification failed: ${verdict.reason}`
      frameos.log(`Plate for ${entry.commonName} rejected: ${verdict.reason}`)
      return { error: `${entry.commonName}: ${entry.lastError}` }
    }
  }

  const folder = cfg.assetFolder || "birdJournal"
  const path = `${folder}/${entry.taxonId}-${slugify(entry.name)}.png`
  if (!frameos.writeAsset(path, generated.image)) {
    entry.attempts += 1
    entry.lastError = "could not save plate asset"
    return { error: `${entry.commonName}: ${entry.lastError}` }
  }
  entry.plate = path
  entry.lastError = ""
  entry.plateDrawnOn = isoDate(now)
  frameos.log(`Added ${entry.commonName} to the journal: ${path}`)
  return {}
}

function pruneCollection(app, journal) {
  const maxSpecies = Math.max(1, Number(app.config.maxSpecies) || 24)
  const entries = Object.values(journal.species)
  if (entries.length <= maxSpecies) {
    return false
  }
  entries.sort((a, b) => String(a.lastSeen || a.firstSeen || "").localeCompare(String(b.lastSeen || b.firstSeen || "")))
  let toRemove = entries.length - maxSpecies
  for (const entry of entries) {
    if (toRemove <= 0) {
      break
    }
    if (entry.plate) {
      frameos.deleteAsset(entry.plate)
    }
    delete journal.species[String(entry.taxonId)]
    toRemove -= 1
  }
  return true
}

export function get(app, context) {
  const cfg = app.config
  const now = Date.now()
  const journalKey = cfg.journalStateKey || "birdJournal"
  const captionKey = cfg.captionStateKey || "birdCaption"
  const journal = readJournal(app, journalKey)
  const notes = []

  const lat = parseFloat(cfg.latitude)
  const lng = parseFloat(cfg.longitude)
  const hasCoords = isFinite(lat) && isFinite(lng)

  if (hasCoords) {
    const pollMillis = Math.max(1, Number(cfg.pollMinutes) || 60) * 60000
    if (now - (journal.lastPollAt || 0) >= pollMillis) {
      const poll = pollSightings(app, journal, lat, lng, now)
      if (poll.error) {
        notes.push(`iNaturalist: ${poll.error}`)
        frameos.error(`iNaturalist poll failed: ${poll.error}`)
      } else {
        journal.lastPollAt = now
        if (poll.newSpecies) {
          frameos.log(`Spotted ${poll.newSpecies} new species`)
        }
      }
      frameos.setState(journalKey, journal)
    }
  } else {
    notes.push("set latitude and longitude to begin")
  }

  const maxAttempts = Math.max(1, Number(cfg.maxAttempts) || 3)
  const pending = Object.values(journal.species)
    .filter((e) => !e.plate && e.attempts < maxAttempts)
    .sort((a, b) => String(a.firstSeen || "").localeCompare(String(b.firstSeen || "")))
  const hasApiKey = (frameos.getSetting("openAI", "apiKey") || "").length > 0

  if (pending.length && hasApiKey) {
    const outcome = drawPendingPlate(app, context, journal, pending[0], now)
    if (outcome.error) {
      notes.push(outcome.error)
    }
    frameos.setState(journalKey, journal)
    if (pending.length > 1) {
      frameos.setNextSleep(20)
    }
  } else if (pending.length) {
    notes.push(`${pending.length} plate${pending.length === 1 ? "" : "s"} waiting for an OpenAI API key`)
  }

  if (pruneCollection(app, journal)) {
    frameos.setState(journalKey, journal)
  }

  const plates = Object.values(journal.species)
    .filter((e) => e.plate)
    .sort((a, b) => String(a.firstSeen || "").localeCompare(String(b.firstSeen || "")))

  if (plates.length) {
    const index = (journal.cursor || 0) % plates.length
    journal.cursor = index + 1
    frameos.setState(journalKey, journal)
    const entry = plates[index]
    const image = frameos.loadAssetImage(entry.plate)
    if (image) {
      const days = Math.max(1, Number(cfg.daysWindow) || 7)
      let caption = entry.commonName
      if (entry.name && entry.name !== entry.commonName) {
        caption += ` — ${entry.name}`
      }
      const sightings = entry.sightings || 1
      caption += ` · ${sightings} sighting${sightings === 1 ? "" : "s"} in ${days} day${days === 1 ? "" : "s"}`
      caption += ` · ${index + 1}/${plates.length}`
      if (notes.length) {
        caption += `\n${notes.join(" · ")}`
      }
      frameos.setState(captionKey, caption)
      return image
    }
    notes.push(`missing plate file for ${entry.commonName}`)
  }

  const speciesCount = Object.keys(journal.species).length
  let status = "Bird field journal"
  if (speciesCount) {
    status += ` · ${speciesCount} species spotted, drawing plates`
  } else if (hasCoords) {
    status += ` · waiting for sightings near ${lat.toFixed(2)}, ${lng.toFixed(2)}`
  }
  if (notes.length) {
    status += `\n${notes.join(" · ")}`
  }
  frameos.setState(captionKey, status)
  return frameos.image({ color: PAPER_COLOR })
}
