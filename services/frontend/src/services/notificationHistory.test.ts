import { describe, expect, it } from "vitest";
import {
  allRead,
  HISTORY_LIMIT,
  type NotificationHistoryItem,
  unreadCount,
  withCarriedHistory,
  withNewNotification,
} from "./notificationHistory";

function item(id: number, read = false): NotificationHistoryItem {
  return { id, message: `m${id}`, variant: "info", timestamp: id, read };
}

const ids = (history: NotificationHistoryItem[]) => history.map((h) => h.id);

describe("withNewNotification", () => {
  it("puts the new notification first", () => {
    expect(ids(withNewNotification([item(2), item(1)], item(3)))).toEqual([3, 2, 1]);
  });

  it("drops the oldest once the history is full", () => {
    const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => item(HISTORY_LIMIT - i));

    const next = withNewNotification(full, item(HISTORY_LIMIT + 1));

    expect(next).toHaveLength(HISTORY_LIMIT);
    expect(next[0].id).toBe(HISTORY_LIMIT + 1);
    expect(next[next.length - 1].id).toBe(2);
  });
});

describe("withCarriedHistory", () => {
  it("appends the carried-over history after what is already shown, capped", () => {
    const shown = [item(10)];
    const carried = Array.from({ length: HISTORY_LIMIT }, (_, i) => item(HISTORY_LIMIT - i));

    const merged = withCarriedHistory(shown, carried);

    expect(merged).toHaveLength(HISTORY_LIMIT);
    expect(ids(merged).slice(0, 3)).toEqual([10, HISTORY_LIMIT, HISTORY_LIMIT - 1]);
  });

  it("keeps the carried entries' optional fields", () => {
    const carried = [{ ...item(1), detail: "LabNotFoundError", action: { label: "Open", url: "https://x" } }];

    expect(withCarriedHistory([], carried)).toEqual(carried);
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["an object", { id: 1, message: "m" }],
    ["an entry without an id", [{ message: "m" }]],
    ["an entry with a non-string message", [{ id: 1, message: 42 }]],
    ["a list with one bad entry", [item(1), "oops"]],
    ["a null entry", [null]],
    ["a number entry", [42]],
  ])("ignores %s and returns the history untouched", (_label, carried) => {
    const shown = [item(1)];

    expect(withCarriedHistory(shown, carried)).toBe(shown);
  });
});

describe("read state", () => {
  it("marks every entry read and counts none unread", () => {
    const history = allRead([item(1), item(2, true), item(3)]);

    expect(history.every((h) => h.read)).toBe(true);
    expect(unreadCount(history)).toBe(0);
  });

  it("returns the same array when nothing was unread, so the state update is a no-op", () => {
    const history = [item(1, true), item(2, true)];

    expect(allRead(history)).toBe(history);
  });

  it("counts the unread entries", () => {
    expect(unreadCount([item(1), item(2, true), item(3)])).toBe(2);
    expect(unreadCount([])).toBe(0);
  });
});
