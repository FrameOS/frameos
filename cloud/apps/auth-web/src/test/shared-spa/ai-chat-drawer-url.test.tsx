// @vitest-environment jsdom
//
// A chat about no frame (the frames home's AI box) lived only in the drawer:
// follow one of its links, close it, reload, and the only way back was to
// ask something new and dig through History. The drawer's URL now names the
// chat (`?drawer=chat&chatId=`), replaced in place as the chat changes, so
// the Back button and a reload open it again, even one older than the
// history's first page.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { router } from "../../../../../../frontend/node_modules/kea-router";

const apiFetchMock = vi.hoisted(() => vi.fn<(input: string) => Promise<Response>>());
vi.mock("../../../../../../frontend/src/utils/apiFetch", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, apiFetch: (input: string) => apiFetchMock(input) };
});

// jsdom has no layout, so the virtualised transcript would show no messages.
vi.mock("../../../../../../frontend/node_modules/react-virtuoso", () => ({
  Virtuoso: ({ data, itemContent }: { data: unknown[]; itemContent: (index: number, item: unknown) => unknown }) => (
    <div>{data.map((item, index) => itemContent(index, item) as JSX.Element)}</div>
  ),
}));

import { initKea } from "../../../../../../frontend/src/initKea";
import { chatLogic } from "../../../../../../frontend/src/scenes/frame/panels/Chat/chatLogic";
import { WorkspaceChatDrawer } from "../../../../../../frontend/src/scenes/workspace/FrameosShell";
import { workspaceLogic } from "../../../../../../frontend/src/scenes/workspace/workspaceLogic";

type TestWindow = Window & {
  FRAMEOS_APP_CONFIG?: Record<string, unknown>;
  FRAMEOS_EMBEDDED_NO_BACKEND?: boolean;
};
const testWindow = window as TestWindow;

const at = "2026-10-20T10:00:00.000Z";
const summary = (id: string, title: string) => ({
  contextId: null,
  contextType: "frame",
  createdAt: at,
  frameId: null,
  id,
  messageCount: 2,
  title,
  updatedAt: at,
});
// chat-old is not on the history's first page: only the URL knows it.
const chats: Record<string, { chat: ReturnType<typeof summary>; reply: string }> = {
  "chat-old": {
    chat: summary("chat-old", "Which frames have the cuteness overflow scene?"),
    reply: "[Kitchen](frameos://frame/f-1) has [Cuteness overflow](frameos://frame/f-1/scene/s-9).",
  },
  "chat-new": { chat: summary("chat-new", "What time is it?"), reply: "Ten." },
};

function respond(url: string): Response {
  if (url.startsWith("/api/ai/chats?")) {
    return Response.json({ chats: [chats["chat-new"]!.chat], hasMore: false, nextOffset: null });
  }
  const id = url.match(/^\/api\/ai\/chats\/([^/?]+)$/)?.[1];
  const entry = id ? chats[id] : undefined;
  if (entry) {
    return Response.json({
      chat: entry.chat,
      messages: [
        { content: entry.chat.title, createdAt: at, id: `${entry.chat.id}-1`, role: "user" },
        { content: entry.reply, createdAt: at, id: `${entry.chat.id}-2`, role: "assistant" },
      ],
    });
  }
  return Response.json({});
}

const search = () => router.values.searchParams as Record<string, unknown>;

beforeEach(() => {
  testWindow.FRAMEOS_APP_CONFIG = { cloudMode: true, cloud_signed_in: true, route_base_path: "/frames" };
  testWindow.FRAMEOS_EMBEDDED_NO_BACKEND = true;
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (url) => respond(url));
  window.history.replaceState({}, "", "/frames?drawer=chat&chatId=chat-old");
  initKea();
});

afterEach(() => {
  cleanup();
  delete testWindow.FRAMEOS_APP_CONFIG;
  delete testWindow.FRAMEOS_EMBEDDED_NO_BACKEND;
});

describe("the chat drawer's URL", () => {
  it("opens the chat it names, links what the reply names, and comes back with Back", async () => {
    const unmount = workspaceLogic.mount();
    expect(workspaceLogic.values.chatDrawerSelection).toMatchObject({ frameId: null, chatId: "chat-old" });
    render(<WorkspaceChatDrawer frameId={null} sceneId={null} />);

    const kitchen = await screen.findByRole("link", { name: "Kitchen" });
    const chat = chatLogic({ frameId: null });
    expect(chat.values.activeChatId).toBe("chat-old");
    // Not on the loaded page, still the chat it is: header, title, context.
    await waitFor(() => expect(chat.values.chats.map((entry) => entry.id)).toEqual(["chat-new"]));
    expect(chat.values.activeChat?.title).toBe("Which frames have the cuteness overflow scene?");
    expect(search().chatId).toBe("chat-old");
    expect(screen.getByRole("link", { name: "Cuteness overflow" }).getAttribute("href")).toBe(
      "/frames/f-1?drawer=scene&sceneId=s-9",
    );

    // A link opens the frame in this tab and closes the drawer.
    expect(kitchen.getAttribute("href")).toBe("/frames/f-1");
    expect(kitchen.getAttribute("target")).toBeNull();
    fireEvent.click(kitchen);
    expect(router.values.location.pathname).toBe("/frames/f-1");
    expect(workspaceLogic.values.chatDrawerSelection).toBeNull();

    // Back: the drawer on that chat again.
    window.history.back();
    await waitFor(() =>
      expect(workspaceLogic.values.chatDrawerSelection).toMatchObject({ frameId: null, chatId: "chat-old" }),
    );
    unmount();
  });

  it("follows the open chat in place: History drops it, another chat replaces it", async () => {
    const unmount = workspaceLogic.mount();
    render(<WorkspaceChatDrawer frameId={null} sceneId={null} />);
    await screen.findByRole("link", { name: "Kitchen" });
    const chat = chatLogic({ frameId: null });
    const entries = window.history.length;

    chat.actions.backToList();
    expect(search().chatId).toBeUndefined();
    expect(search().drawer).toBe("chat");

    chat.actions.selectChat("chat-new");
    await screen.findByText("Ten.");
    expect(search().chatId).toBe("chat-new");
    expect(workspaceLogic.values.chatDrawerSelection?.chatId).toBe("chat-new");
    expect(router.values.lastMethod).toBe("REPLACE");
    expect(window.history.length).toBe(entries);

    // A new chat nobody wrote in yet has no stored id to name.
    chat.actions.createChat();
    expect(search().chatId).toBeUndefined();
    unmount();
  });

  // The drawer opened on an empty chat before the history loaded, and when
  // the history dropped it for the stored one, the URL named the id it left
  // behind: a chat the server never had.
  it("without a chat id, opens the latest stored chat once the history loads", async () => {
    window.history.replaceState({}, "", "/frames?drawer=chat");
    initKea();
    const unmount = workspaceLogic.mount();
    render(<WorkspaceChatDrawer frameId={null} sceneId={null} />);

    await screen.findByText("Ten.");
    const chat = chatLogic({ frameId: null });
    expect(chat.values.activeChatId).toBe("chat-new");
    expect(search().chatId).toBe("chat-new");

    // New chat, then History: the list stays open on its reload.
    chat.actions.createChat();
    expect(search().chatId).toBeUndefined();
    chat.actions.backToList();
    await waitFor(() => expect(chat.values.isLoadingChats).toBe(false));
    expect(chat.values.chatView).toBe("list");
    unmount();
  });
});
