import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "release/**",
      "evidence/**",
      "runtime/sources/workitems/**",
      "vendor/**"
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
  },
  {
    // .cjs 脚本：require() 是 CommonJS 标准导入方式；catch 变量常未使用
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }]
    }
  }
);
