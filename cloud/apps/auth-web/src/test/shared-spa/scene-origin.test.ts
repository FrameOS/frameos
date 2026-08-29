// The shared SPA's origin helpers (frontend/src/utils/sceneOrigin.ts) with
// store-backed repositories: a scene installed from the FrameOS Cloud store
// carries href + storeSceneId + version, and is matched back to the store's
// index entry by uuid — whichever repository listed it, and even when the
// stamp came from a downloaded zip rather than the Templates panel.
import { describe, expect, it } from "vitest";
import {
  findTemplateForOrigin,
  sameTemplateOrigin,
  sceneOriginForTemplate,
  sceneUpdateVersion,
  templateWithSceneOrigins,
} from "../../../../../../frontend/src/utils/sceneOrigin";
import type {
  FrameScene,
  RepositoryType,
  TemplateType,
} from "../../../../../../frontend/src/types";

const storeSceneId = "0f3d1c2a-1111-4222-8333-444455556666";

const storeTemplate: TemplateType = {
  id: "visited-world-map",
  name: "Visited World Map",
  sceneId: storeSceneId,
  url: "https://scenes.frameos.net/s/visited-world-map",
  version: "6",
} as TemplateType;

const storeRepository: RepositoryType = {
  id: "frameos-cloud-store",
  name: "FrameOS Cloud store",
  url: "https://cloud.frameos.net/api/store/repository.json",
  templates: [storeTemplate],
} as RepositoryType;

const plainRepository: RepositoryType = {
  id: "gallery",
  name: "Gallery",
  url: "https://example.com/repo.json",
  templates: [{ id: "clock", name: "Clock", version: "abc123" } as TemplateType],
} as RepositoryType;

describe("store scene origins in the shared SPA", () => {
  it("stamps store installs with the page, uuid and version", () => {
    const origin = sceneOriginForTemplate(storeRepository, storeTemplate, "visited-world-map");
    expect(origin).toEqual({
      href: "https://scenes.frameos.net/s/visited-world-map",
      repositoryId: "frameos-cloud-store",
      repositoryUrl: storeRepository.url,
      sceneId: "visited-world-map",
      storeSceneId,
      templateId: "visited-world-map",
      templateName: "Visited World Map",
      version: "6",
    });
    const stamped = templateWithSceneOrigins(
      { ...storeTemplate, scenes: [{ id: "visited-world-map", name: "x", nodes: [], edges: [] }] },
      storeRepository
    );
    expect(stamped.scenes?.[0].origin?.storeSceneId).toBe(storeSceneId);
  });

  it("keeps plain repository installs as before (no href, no uuid)", () => {
    const origin = sceneOriginForTemplate(plainRepository, plainRepository.templates![0], "clock");
    expect(origin).toEqual({
      repositoryId: "gallery",
      repositoryUrl: "https://example.com/repo.json",
      sceneId: "clock",
      templateId: "clock",
      templateName: "Clock",
      version: "abc123",
    });
  });

  it("matches a cloud-stamped scene (no repository fields) to the store index by uuid", () => {
    // What the cloud serves: href + storeSceneId + version, nothing about a
    // repository — the same stamp a downloaded zip carries.
    const scene = {
      id: "visited-world-map",
      name: "Visited World Map",
      nodes: [],
      edges: [],
      origin: {
        href: "https://scenes.frameos.net/s/visited-world-map",
        sceneId: "visited-world-map",
        storeSceneId,
        version: "4",
      },
    } as FrameScene;
    const match = findTemplateForOrigin([plainRepository, storeRepository], scene.origin);
    expect(match?.template).toBe(storeTemplate);
    expect(sceneUpdateVersion(scene, [plainRepository, storeRepository])).toBe("6");
    expect(
      sceneUpdateVersion({ ...scene, origin: { ...scene.origin, version: "6" } }, [storeRepository])
    ).toBeNull();
  });

  it("treats two stamps of one store scene as the same template", () => {
    expect(
      sameTemplateOrigin(
        { storeSceneId, version: "4", href: "https://scenes.frameos.net/s/visited-world-map" },
        { storeSceneId, repositoryUrl: storeRepository.url, templateId: "visited-world-map", version: "6" }
      )
    ).toBe(true);
    expect(
      sameTemplateOrigin(
        { storeSceneId, version: "4" },
        { storeSceneId: "ffffffff-0000-4000-8000-000000000000", version: "4" }
      )
    ).toBe(false);
  });
});
