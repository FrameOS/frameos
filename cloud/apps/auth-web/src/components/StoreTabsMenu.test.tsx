// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StoreTabsMenu } from "./StoreTabsMenu";

afterEach(cleanup);

describe("StoreTabsMenu", () => {
  it("keeps the converter behind the … button, as a plain link", () => {
    render(<StoreTabsMenu convertUrl="https://scenes.example/nim-converter" />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByTestId("store-tabs-menu"));
    const item = screen.getByText("Convert a legacy compiled scene").closest("a");
    expect(item?.getAttribute("href")).toBe("https://scenes.example/nim-converter");
    expect(screen.getByText(/whole-frame recompilation/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("store-tabs-menu"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
