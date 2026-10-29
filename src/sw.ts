/// <reference lib="webworker" />

/** What the API sends for an urgent notification. */
export interface EventKitPush {
  title?: string;
  body?: string;
  /** The hosted front end's page for it: /events/{eventId}/notifications */
  url?: string;
  tag?: string;
  eventId?: string;
  notificationId?: string;
  channelId?: string;
}

export interface PushHandlerOptions {
  /** Where a click goes on your site. Default: the payload's url, else "/". */
  urlFor?: (push: EventKitPush) => string;
  /** Icon shown with notifications. */
  icon?: string;
}

/**
 * Shows eventKit's urgent notifications and opens your page when one is
 * clicked. In your service worker:
 *
 *   import { registerPushHandlers } from '@eventkit-sdk/client/sw';
 *   registerPushHandlers(self, { urlFor: (p) => `/updates#${p.notificationId}` });
 */
export function registerPushHandlers(
  sw: ServiceWorkerGlobalScope,
  options: PushHandlerOptions = {},
): void {
  sw.addEventListener('push', (event) => {
    let data: EventKitPush;
    try {
      data = (event.data?.json() as EventKitPush | undefined) ?? {};
    } catch {
      data = { body: event.data?.text() };
    }
    const url = options.urlFor ? options.urlFor(data) : (data.url ?? '/');
    event.waitUntil(
      sw.registration.showNotification(data.title ?? 'eventKit', {
        body: data.body,
        ...(data.tag ? { tag: data.tag } : {}),
        ...(options.icon ? { icon: options.icon } : {}),
        data: { url },
      }),
    );
  });

  sw.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
    event.waitUntil(sw.clients.openWindow(url));
  });
}
