import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "release/**",
      "evidence/**",
      "runtime/sources/workitems/**"
    ]
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // AR006: 禁止第三方编辑器内核
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["monaco-editor", "monaco-editor/*"], message: "AR006: DevWit 自研编辑器内核，禁止 Monaco" },
            { group: ["@codemirror/*", "codemirror"], message: "AR006: DevWit 自研编辑器内核，禁止 CodeMirror" }
          ]
        }
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "error"
    }
  }
);
