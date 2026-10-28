// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initKea } from "../../../../../../frontend/src/initKea";
import { locateButtonLogic } from "../../../../../../frontend/src/components/locateButtonLogic";
import {
  coordinateValue,
  currentLocation,
  locatedValues,
  locationFieldPair,
} from "../../../../../../frontend/src/utils/geolocation";

// A scene whose state takes a latitude and a longitude gets a locate button
// on the first of the two in every state form (StateFieldEdit's callers and
// the store's live preview): the browser's location fills both.

function field(name: string, type = "float") {
  return { name, type };
}

function stubGeolocation(getCurrentPosition: Geolocation["getCurrentPosition"]) {
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
}

afterEach(() => {
  delete (navigator as { geolocation?: unknown }).geolocation;
});

describe("locationFieldPair", () => {
  it("finds a latitude and a longitude, and names the first of them in the form", () => {
    const radar = [field("radiusKm"), field("latitude"), field("longitude")];
    expect(locationFieldPair(radar)).toEqual({ first: "latitude", latitude: radar[1], longitude: radar[2] });
    const flipped = [field("lng", "string"), field("Lat", "string")];
    expect(locationFieldPair(flipped)?.first).toBe("lng");
  });

  it("needs both, drawn as text boxes", () => {
    expect(locationFieldPair([field("latitude")])).toBeNull();
    expect(locationFieldPair([field("latitude"), field("longitude", "select")])).toBeNull();
    expect(locationFieldPair([field("latitudeOffset"), field("longitude")])).toBeNull();
  });
});

describe("located values", () => {
  it("keeps a number field a number and a text field text, to about a metre", () => {
    expect(coordinateValue({ type: "float" }, 59.43696081)).toBe(59.43696);
    expect(coordinateValue({ type: "string" }, -0.12775829)).toBe("-0.12776");
    expect(coordinateValue({ type: "integer" }, 24.75)).toBe(25);
    const pair = locationFieldPair([field("lat", "string"), field("lon")])!;
    expect(locatedValues(pair, { latitude: 59.4369608, longitude: 24.7535747 })).toEqual({
      lat: "59.43696",
      lon: 24.75357,
    });
  });
});

describe("currentLocation", () => {
  it("asks the browser, and words a refusal as what to do about it", async () => {
    stubGeolocation((success) =>
      success({ coords: { latitude: 1.5, longitude: 2.5 } } as GeolocationPosition),
    );
    await expect(currentLocation()).resolves.toEqual({ latitude: 1.5, longitude: 2.5 });
    stubGeolocation((_success, failure) => failure?.({ code: 1, message: "denied" } as GeolocationPositionError));
    await expect(currentLocation()).rejects.toThrow("Location access was denied");
    delete (navigator as { geolocation?: unknown }).geolocation;
    await expect(currentLocation()).rejects.toThrow("This browser cannot tell your location.");
  });

  it("says why on a page opened over plain HTTP, where browsers never share it", async () => {
    const getCurrentPosition = vi.fn();
    stubGeolocation(getCurrentPosition);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    try {
      await expect(currentLocation()).rejects.toThrow("only with pages opened over HTTPS");
      expect(getCurrentPosition).not.toHaveBeenCalled();
    } finally {
      delete (window as { isSecureContext?: boolean }).isSecureContext;
    }
  });
});

describe("locateButtonLogic", () => {
  let unmount: () => void;

  beforeEach(() => {
    initKea({ memoryRouter: true });
    unmount = locateButtonLogic.mount();
  });

  afterEach(() => {
    unmount();
  });

  it("hands the location to the form that asked, spinning meanwhile", async () => {
    let answer: PositionCallback = () => {};
    stubGeolocation((success) => {
      answer = success;
    });
    const onLocated = vi.fn();
    locateButtonLogic.actions.locate(onLocated);
    expect(locateButtonLogic.values.locating).toBe(true);
    answer({ coords: { latitude: 3, longitude: 4 } } as GeolocationPosition);
    await vi.waitFor(() => expect(locateButtonLogic.values.locating).toBe(false));
    expect(onLocated).toHaveBeenCalledWith({ latitude: 3, longitude: 4 });
    expect(locateButtonLogic.values.error).toBeNull();
  });

  it("keeps the reason when the browser says no, until the next try", async () => {
    stubGeolocation((_success, failure) => failure?.({ code: 3, message: "timeout" } as GeolocationPositionError));
    const onLocated = vi.fn();
    locateButtonLogic.actions.locate(onLocated);
    await vi.waitFor(() => expect(locateButtonLogic.values.error).toBe("Finding your location took too long. Try again."));
    expect(onLocated).not.toHaveBeenCalled();
    locateButtonLogic.actions.locate(onLocated);
    expect(locateButtonLogic.values.error).toBeNull();
  });
});
