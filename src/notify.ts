import type { NotificationConfig } from "./config.js";

/*
  Outbound notifications: Discord, Slack, Telegram, or any webhook. Strictly
  fire-and-forget — a dead Discord URL must never delay or fail an order.
  Failures are logged once per send, never thrown.
*/

export type NotifyEventType = "fill" | "reject" | "error" | "kill" | "flatten";

export type NotifyEvent = {
  type: NotifyEventType;
  title: string;
  body: string;
};

export type Notifier = {
  send: (event: NotifyEvent) => void;
};

const asText = (event: NotifyEvent): string => `${event.title}\n${event.body}`;

const dispatch = async (target: NotificationConfig, event: NotifyEvent, fetchImpl: typeof fetch): Promise<void> => {
  if (target.type === "telegram") {
    const url = `https://api.telegram.org/bot${target.botToken}/sendMessage`;
    await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: target.chatId, text: asText(event) }),
    });
    return;
  }
  const body =
    target.type === "discord"
      ? JSON.stringify({ content: asText(event).slice(0, 1900) })
      : target.type === "slack"
        ? JSON.stringify({ text: asText(event) })
        : JSON.stringify(event);
  await fetchImpl(target.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
};

export const createNotifier = (
  targets: NotificationConfig[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Notifier => ({
  send: (event) => {
    for (const target of targets) {
      if (!target.events.includes(event.type)) continue;
      void dispatch(target, event, fetchImpl).catch((error: unknown) => {
        console.error(`[trade-relay] notification (${target.type}) failed: ${(error as Error).message}`);
      });
    }
  },
});
