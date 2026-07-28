/**
 * Ambient declaration so TypeScript (moduleResolution: NodeNext) can resolve the
 * subpath import `posthog-js/dist/module.full.no-external` used by posthog.ts.
 *
 * The package ships no `exports` map, so NodeNext cannot resolve the deep path
 * even though the .d.ts exists on disk. We re-export from the package root.
 *
 * The package's `.d.ts` exposes `posthog` as a named export and as `default`,
 * but under NodeNext the legacy `module`-field resolution binds the default
 * import to the module namespace rather than the `posthog` singleton. Re-export
 * the named singleton as the default so `import posthog from '.../no-external'`
 * resolves to the instance.
 */
declare module 'posthog-js/dist/module.full.no-external' {
  export { posthog as default } from 'posthog-js'
  export * from 'posthog-js'
}
