"use client";

import { useState } from "react";
import {
  describeSettingsError,
  serviceSettingsFrom,
  serviceSettingsGroups,
  type ServiceFieldSpec,
  type ServiceGroupSpec,
  type ServiceSettingsValues,
} from "../lib/account-settings-form";
import { isMaskedSettingValue } from "../lib/setting-mask";

// The service API keys on /account/settings. One form, one Save: the whole
// object goes to POST /api/settings, which replaces every group wholesale
// and answers with what it stored — the form resets from that answer, so
// what is on screen after a save is what the database holds. Cloud-managed
// frames are nudged to re-pull their keys by the route, not by us.
//
// Saved keys never come back in full: the page renders them as a mask
// (`••••••••cdef`), and posting the mask back keeps the stored key. Typing
// over it replaces the key; clearing the field removes it.

// "A key ending in cdef is saved." — the mask carries the tail when the key
// is long enough for one (setting-mask.ts).
function describeSavedSecret(mask: string): string {
  const tail = mask.replace(/•/g, "");
  return tail ? `A key ending in ${tail} is saved.` : "A key is saved.";
}

function hasAdvancedValues(values: ServiceSettingsValues): boolean {
  return serviceSettingsGroups.some((group) =>
    group.fields.some(
      (field) => field.advanced && (values[group.key]?.[field.name] ?? "") !== "",
    ),
  );
}

function FieldInput({
  group,
  field,
  value,
  onChange,
}: {
  group: ServiceGroupSpec;
  field: ServiceFieldSpec;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `${group.key}-${field.name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{field.label}</label>
      {field.options ? (
        <select
          className="input"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          value={value}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          autoComplete={field.secret ? "new-password" : "off"}
          className="input"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          spellCheck={false}
          type={field.secret ? "password" : "text"}
          value={value}
        />
      )}
      {field.secret && isMaskedSettingValue(value) ? (
        <p className="copy account-settings__hint">
          {describeSavedSecret(value)} Type a new one to replace it, or clear
          the field to remove it.
        </p>
      ) : null}
      {field.hint ? <p className="copy account-settings__hint">{field.hint}</p> : null}
    </div>
  );
}

export function AccountSettingsForm({ initial }: { initial: ServiceSettingsValues }) {
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [justSaved, setJustSaved] = useState(false);
  const [showModelSettings, setShowModelSettings] = useState(() => hasAdvancedValues(initial));
  const changed = JSON.stringify(values) !== JSON.stringify(saved);

  function update(group: string, field: string, value: string) {
    setJustSaved(false);
    setValues((current) => ({
      ...current,
      [group]: { ...current[group], [field]: value },
    }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/settings", {
        body: JSON.stringify(values),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => undefined)) as
        | (Record<string, unknown> & { error?: string })
        | undefined;
      if (!response.ok) {
        setError(describeSettingsError(response.status, payload?.error));
        return;
      }
      const next = serviceSettingsFrom(payload);
      setSaved(next);
      setValues(next);
      setJustSaved(true);
    } catch {
      setError(describeSettingsError(0, undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack-lg" onSubmit={(event) => void save(event)}>
      {serviceSettingsGroups.map((group) => {
        const groupValues = values[group.key] ?? {};
        const advanced = group.fields.some((field) => field.advanced);
        return (
          <section className="card" id={group.id} key={group.key}>
            <h3>{group.title}</h3>
            {group.intro ? <p className="copy">{group.intro}</p> : null}
            {group.introLink ? (
              <p className="copy">
                <a href={group.introLink.href} rel="noreferrer" target="_blank">
                  {group.introLink.label}
                </a>
                {group.introLink.after}
              </p>
            ) : null}
            <div className="stack account-settings__fields">
              {group.fields
                .filter((field) => !field.advanced || showModelSettings)
                .map((field) => (
                  <FieldInput
                    field={field}
                    group={group}
                    key={field.name}
                    onChange={(value) => update(group.key, field.name, value)}
                    value={groupValues[field.name] ?? ""}
                  />
                ))}
              {advanced ? (
                <div>
                  <button
                    className="button button--small button--subtle"
                    onClick={() => setShowModelSettings((current) => !current)}
                    type="button"
                  >
                    {showModelSettings ? "Hide model settings" : "Show model settings"}
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        );
      })}

      {error ? (
        <p className="notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {justSaved && !changed ? (
        <p className="notice" role="status">
          Saved. Your frames pick up the new keys on their next check-in.
        </p>
      ) : null}

      <div className="button-row account-settings__actions">
        <button className="button button-primary" disabled={!changed || busy} type="submit">
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          className="button"
          disabled={!changed || busy}
          onClick={() => {
            setValues(saved);
            setError(undefined);
          }}
          type="button"
        >
          Reset
        </button>
      </div>
    </form>
  );
}
