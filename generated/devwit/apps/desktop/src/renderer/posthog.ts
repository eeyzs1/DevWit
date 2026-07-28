/**
 * PostHog analytics module for the renderer process.
 * Keys are injected at build time via esbuild --define (scripts/build-renderer.mjs).
 * All calls are guarded — missing config disables analytics without breaking the app.
 */
import posthog from 'posthog-js/dist/module.full.no-external'

// Substituted at build time by scripts/build-renderer.mjs
const API_KEY: string = process.env['POSTHOG_API_KEY'] ?? ''
const HOST: string = process.env['POSTHOG_HOST'] ?? ''

function warnMissing(varName: string): void {
  console.error(
    `${varName} variable required by PostHog is missing or un-configured, ` +
      `this causes events to be silently missed. ` +
      `This error stops appearing once ${varName} is configured`
  )
}

/** Call once at app startup, before any capture/identify calls. */
export function initPostHog(): void {
  if (!API_KEY || !HOST) {
    if (!API_KEY) warnMissing('POSTHOG_API_KEY')
    if (!HOST) warnMissing('POSTHOG_HOST')
    return
  }
  posthog.init(API_KEY, {
    api_host: HOST,
    defaults: '2026-05-30',
  })
}

/** Link all future events to this stable install ID. */
export function identifyInstall(installId: string): void {
  if (!API_KEY) return
  posthog.identify(installId)
}

/** Capture a named event with optional scalar properties. Never include PII. */
export function captureEvent(
  event: string,
  props?: Record<string, string | number | boolean>
): void {
  if (!API_KEY) return
  posthog.capture(event, props)
}

/** Capture a caught exception for error tracking. */
export function captureError(
  error: unknown,
  props?: Record<string, string | number | boolean>
): void {
  if (!API_KEY) return
  posthog.captureException(error, props)
}
