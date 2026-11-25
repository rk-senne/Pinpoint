// Composition helper: builds everything Slack auto-notify needs so the
// container only has to (1) pass `channelDeliverers` to the notification
// dispatcher and (2) call `attach(eventBus)` once.
import type { Knex } from 'knex';
import type { EventBus } from '../../domain/shared/ports/EventBus.js';
import type { Logger } from '../../domain/shared/ports/Logger.js';
import type { IntegrationRepo } from '../../domain/integration/ports/IntegrationRepo.js';
import type { NotificationQueue } from '../../domain/notification/ports/NotificationQueue.js';
import type { ChannelDeliverer } from '../../domain/notification/usecases/dispatchPendingNotifications.js';
import type { EgressGuardOptions } from '../egressGuard.js';
import { createSlackProvider } from './slackProvider.js';
import { SLACK_NOTIFICATION_KIND, createSlackAnnotationNotifier, createSlackQueueDelivery } from './slackNotifier.js';

export interface SlackWiringDeps {
  db: Knex;
  integrationRepo: IntegrationRepo;
  notificationQueue: Pick<NotificationQueue, 'enqueue'>;
  logger: Logger;
  appUrl: string;
  egressOptions?: EgressGuardOptions;
}

export interface SlackWiring {
  /** Pass to `DispatchPendingNotifications({ channelDeliverers })`. */
  channelDeliverers: { slack_annotation: ChannelDeliverer };
  /**
   * Hook `annotation.created` on `bus` (in place, so the bus keeps its class).
   * The notifier runs detached: it can never block or fail `emit`.
   */
  attach(bus: EventBus): void;
}

export function createSlackWiring(deps: SlackWiringDeps): SlackWiring {
  const provider = createSlackProvider({ egressOptions: deps.egressOptions ?? {} });
  const notifier = createSlackAnnotationNotifier({
    db: deps.db,
    integrationRepo: deps.integrationRepo,
    notificationQueue: deps.notificationQueue,
    logger: deps.logger,
  });
  const deliver = createSlackQueueDelivery({
    db: deps.db,
    integrationRepo: deps.integrationRepo,
    provider,
    appUrl: deps.appUrl,
    logger: deps.logger,
  });
  return {
    channelDeliverers: { [SLACK_NOTIFICATION_KIND]: deliver } as { slack_annotation: ChannelDeliverer },
    attach(bus: EventBus): void {
      const original = bus.emit.bind(bus);
      bus.emit = (event) => {
        original(event);
        if (event.type === 'annotation.created') void notifier.onAnnotationCreated(event.payload);
      };
    },
  };
}
