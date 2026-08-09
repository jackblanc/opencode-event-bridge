import { recommended, style } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [recommended, style],
  plugins: ["import", "vitest"],
  options: {
    reportUnusedDisableDirectives: "error",
    denyWarnings: true,
    typeAware: true,
    typeCheck: true,
  },
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "error",
  },
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "node:crypto",
            message: "Use Effect Crypto service and provide a platform layer at the boundary.",
          },
          {
            name: "crypto",
            message: "Use Effect Crypto service and provide a platform layer at the boundary.",
          },
          {
            name: "node:fs",
            message: "Use Effect FileSystem service and provide a platform layer at the boundary.",
          },
          {
            name: "fs",
            message: "Use Effect FileSystem service and provide a platform layer at the boundary.",
          },
          {
            name: "node:path",
            message: "Use Effect Path service and provide a platform layer at the boundary.",
          },
          {
            name: "path",
            message: "Use Effect Path service and provide a platform layer at the boundary.",
          },
          {
            name: "bun",
            message: "Use Effect services and provide a platform layer at the boundary.",
          },
          {
            name: "@opencode-ai/sdk/v1",
            message:
              "Import from '@opencode-ai/sdk/v2' instead of v1 for better type safety and features.",
          },
          {
            name: "@opencode-ai/sdk",
            message:
              "Import from '@opencode-ai/sdk/v2' instead of the root SDK package for better type safety and features.",
          },
        ],
      },
    ],

    "eslint/default-case-last": "error",
    "eslint/eqeqeq": "error",
    "eslint/max-params": ["error", 3],
    "eslint/no-console": "error",
    "eslint/no-else-return": "error",
    "eslint/no-param-reassign": "error",
    "eslint/no-regex-spaces": "error",
    "eslint/no-self-compare": "error",
    "eslint/no-var": "error",

    "import/consistent-type-specifier-style": ["error", "prefer-top-level"],
    "import/no-commonjs": "error",
    "import/no-cycle": "error",
    "import/no-duplicates": "error",
    "import/no-dynamic-require": "error",
    "import/no-unassigned-import": "error",

    "typescript/consistent-type-assertions": [
      "error",
      {
        assertionStyle: "never",
      },
    ],
    "typescript/consistent-type-imports": [
      "error",
      {
        prefer: "type-imports",
        fixStyle: "separate-type-imports",
      },
    ],
    "typescript/explicit-module-boundary-types": [
      "error",
      {
        allowHigherOrderFunctions: false,
      },
    ],
    "typescript/no-confusing-void-expression": "error",
    "typescript/no-deprecated": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-import-type-side-effects": "error",
    "typescript/no-misused-promises": "error",
    "typescript/no-namespace": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/no-require-imports": "error",
    "typescript/no-unnecessary-condition": "error",
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/only-throw-error": "error",
    "typescript/prefer-nullish-coalescing": "error",
    "typescript/prefer-promise-reject-errors": "error",
    "typescript/require-await": "error",
    "typescript/restrict-plus-operands": "error",
    "typescript/return-await": "error",
    "typescript/strict-void-return": "error",
    "typescript/switch-exhaustiveness-check": [
      "error",
      {
        considerDefaultExhaustiveForUnions: true,
      },
    ],
    "typescript/use-unknown-in-catch-callback-variable": "error",

    "unicorn/no-abusive-eslint-disable": "error",
    "unicorn/no-instanceof-array": "error",
    "unicorn/no-useless-promise-resolve-reject": "error",
    "unicorn/no-useless-undefined": "error",
    "unicorn/prefer-array-some": "error",
    "unicorn/prefer-modern-math-apis": "error",
    "unicorn/prefer-node-protocol": "error",
    "unicorn/prefer-string-slice": "error",
    "unicorn/throw-new-error": "error",

    "vitest/expect-expect": [
      "error",
      {
        additionalTestBlockFunctions: ["it.effect"],
        assertFunctionNames: ["assert", "assertType", "expect", "expectTypeOf"],
      },
    ],
    "vitest/no-standalone-expect": [
      "error",
      {
        additionalTestBlockFunctions: ["it.effect"],
      },
    ],
  },
});
