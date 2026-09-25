// The notification history's shape and the list operations ToastContext applies to it. The single
// source of truth for the history's cap and for what counts as a valid entry when the desktop shell
// hands a saved history back after a reload it triggered.

export type ToastVariant = "success" | "danger" | "info";

/** An optional action button a toast/notification can offer — e.g. "Download" on an
 *  update-available notice (see UpdateChecker.tsx). Deliberately a plain url string rather than a
 *  callback: it must survive the notification history's IPC round-trip (saveNotificationHistory/
 *  loadNotificationHistory) across a shell-triggered reload, which a closure can't. */
export interface ToastAction {
  label: string;
  url: string;
}

export interface NotificationHistoryItem {
  id: number;
  message: string;
  detail?: string;
  variant: ToastVariant;
  timestamp: number;
  read: boolean;
  action?: ToastAction;
}

// Cap so a long-running session doesn't grow the history array unbounded.
export const HISTORY_LIMIT = 200;

/** Loose runtime check on whatever the shell hands back from a prior saveNotificationHistory —
 * cheap insurance against a future shape change, not full validation. */
function isHistoryItem(v: unknown): v is NotificationHistoryItem {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as NotificationHistoryItem).id === "number" &&
    typeof (v as NotificationHistoryItem).message === "string"
  );
}

/** `history` with a newly shown notification on top, capped. */
export function withNewNotification(
  history: NotificationHistoryItem[],
  item: NotificationHistoryItem,
): NotificationHistoryItem[] {
  return [item, ...history].slice(0, HISTORY_LIMIT);
}

/** `history` followed by the history the shell carried over a reload, capped — or `history`
 *  itself, untouched, when `carried` is not a list of valid entries.
 *
 *  The carried half goes *after* `history`: loading it is an IPC round-trip that races any
 *  notification shown by another component's mount-time effect, and the carried entries are
 *  always the older ones in a newest-first list. */
export function withCarriedHistory(history: NotificationHistoryItem[], carried: unknown): NotificationHistoryItem[] {
  if (!Array.isArray(carried) || !carried.every(isHistoryItem)) return history;
  return [...history, ...carried].slice(0, HISTORY_LIMIT);
}

/** `history` with every entry read — the same array when nothing was unread, so the caller's
 *  state update is a no-op. */
export function allRead(history: NotificationHistoryItem[]): NotificationHistoryItem[] {
  return history.some((h) => !h.read) ? history.map((h) => ({ ...h, read: true })) : history;
}

export function unreadCount(history: NotificationHistoryItem[]): number {
  return history.reduce((n, h) => n + (h.read ? 0 : 1), 0);
}
