import type {
  Env,
  Inbox,
  NotificationChannel,
  DiscordChannelConfig,
  SlackChannelConfig,
  TeamsChannelConfig,
  TelegramChannelConfig,
  NtfyChannelConfig,
  WebhookChannelConfig,
  EmailChannelConfig,
} from '../types';
import type { ChannelContext } from './base';
import { buildDiscordPayload } from './discord';
import { buildSlackPayload } from './slack';
import { buildTeamsPayload } from './teams';
import { buildTelegramPayload } from './telegram';
import { buildNtfyPayload } from './ntfy';
import { buildWebhookPayload } from './webhook';
import { buildEmailPayload } from './email';
import { detectChannelType } from './detect';
import { buildEmailHtml } from '../services/email-template';

/**
 * Dispatches notifications to all active channels for an inbox
 * Handles both HTTP-based channels (Discord, Slack, etc.) and email channels
 */
export async function dispatchNotifications(
  inbox: Inbox,
  body: Record<string, unknown>,
  executionCtx: ExecutionContext,
  env: Env,
): Promise<void> {
  // Load all active channels for this inbox
  const channelsResult = await env.DB.prepare(
    'SELECT * FROM notification_channels WHERE inbox_id = ? AND is_active = 1',
  )
    .bind(inbox.id)
    .all<NotificationChannel>();

  const channels = channelsResult.results || [];

  if (channels.length === 0) {
    return;
  }

  // Build context once for all channels
  const context: ChannelContext = {
    slug: inbox.slug,
    subjectPrefix: inbox.email_subject_prefix || `[${inbox.slug}]`,
    senderName: inbox.sender_name || 'HookForms',
    body,
  };

  // Process each channel
  for (const channel of channels) {
    try {
      const config = JSON.parse(channel.config);
      let channelType = channel.type;

      // Auto-detect if type is 'webhook'
      if (channelType === 'webhook' && config.url) {
        channelType = detectChannelType(config.url);
      }

      // Route to appropriate adapter
      switch (channelType) {
        case 'discord': {
          const payload = buildDiscordPayload(config as DiscordChannelConfig, context);
          executionCtx.waitUntil(
            fetch(payload.url, {
              method: payload.method,
              headers: payload.headers,
              body: payload.body,
            }).catch((err) => console.error(`Discord dispatch failed for channel ${channel.id}:`, err)),
          );
          break;
        }

        case 'slack': {
          const payload = buildSlackPayload(config as SlackChannelConfig, context);
          executionCtx.waitUntil(
            fetch(payload.url, {
              method: payload.method,
              headers: payload.headers,
              body: payload.body,
            }).catch((err) => console.error(`Slack dispatch failed for channel ${channel.id}:`, err)),
          );
          break;
        }

        case 'teams': {
          const payload = buildTeamsPayload(config as TeamsChannelConfig, context);
          executionCtx.waitUntil(
            fetch(payload.url, {
              method: payload.method,
              headers: payload.headers,
              body: payload.body,
            }).catch((err) => console.error(`Teams dispatch failed for channel ${channel.id}:`, err)),
          );
          break;
        }

        case 'telegram': {
          const payload = buildTelegramPayload(config as TelegramChannelConfig, context);
          executionCtx.waitUntil(
            fetch(payload.url, {
              method: payload.method,
              headers: payload.headers,
              body: payload.body,
            }).catch((err) => console.error(`Telegram dispatch failed for channel ${channel.id}:`, err)),
          );
          break;
        }

        case 'ntfy': {
          const payload = buildNtfyPayload(config as NtfyChannelConfig, context);
          executionCtx.waitUntil(
            fetch(payload.url, {
              method: payload.method,
              headers: payload.headers,
              body: payload.body,
            }).catch((err) => console.error(`Ntfy dispatch failed for channel ${channel.id}:`, err)),
          );
          break;
        }

        case 'webhook': {
          const payload = buildWebhookPayload(config as WebhookChannelConfig, context);
          executionCtx.waitUntil(
            fetch(payload.url, {
              method: payload.method,
              headers: payload.headers,
              body: payload.body,
            }).catch((err) => console.error(`Webhook dispatch failed for channel ${channel.id}:`, err)),
          );
          break;
        }

        case 'email': {
          // Rate limit: max 10 emails per inbox per 10 minutes
          const rateKey = `channel_email_rate:${inbox.id}`;
          try {
            const current = await env.RATE_LIMIT.get(rateKey);
            const count = current ? parseInt(current, 10) : 0;
            if (count >= 10) {
              console.warn(`Email rate limit hit for inbox ${inbox.slug}`);
              break;
            }
            executionCtx.waitUntil(
              env.RATE_LIMIT.put(rateKey, String(count + 1), { expirationTtl: 600 }),
            );
          } catch {
            // KV unavailable — allow through
          }

          const emailPayload = buildEmailPayload(config as EmailChannelConfig);
          const htmlBody = buildEmailHtml(context.slug, context.body, context.senderName);

          // Determine subject detail
          const name = String(body.name || 'Unknown');
          const subjectDetail = name !== 'Unknown' ? `from ${name}` : 'New Submission';

          // Queue email for each recipient (with inbox_id for provider resolution)
          for (const to of emailPayload.recipients) {
            executionCtx.waitUntil(
              env.EMAIL_QUEUE.send({
                to,
                subject: `${context.subjectPrefix} ${subjectDetail}`,
                body: htmlBody,
                sender_name: context.senderName,
                inbox_id: inbox.id,
              }).catch((err) => console.error(`Email queue send failed for ${to} on channel ${channel.id}:`, err)),
            );
          }
          break;
        }
      }
    } catch (error) {
      // Log error but continue processing other channels
      console.error(`Failed to dispatch to channel ${channel.id}:`, error);
    }
  }
}
