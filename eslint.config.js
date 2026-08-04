import config from '@swarmmachina/standards/eslint-typescript'

const publicApiFiles = [
  'src/index.ts',
  'src/types.ts',
  'src/discovery.ts',
  'src/cdp/cdp-error.ts',
  'src/cdp/connect.ts',
  'src/cdp/connection/remote-connection.ts',
  'src/spawn/browser.ts',
  'src/spawn/spawn-chrome.ts'
]
const publicTypeContexts = [
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration TSPropertySignature',
  'TSInterfaceDeclaration TSMethodSignature',
  'TSInterfaceDeclaration TSIndexSignature',
  'TSTypeAliasDeclaration TSPropertySignature',
  'TSTypeAliasDeclaration TSMethodSignature',
  'ExportNamedDeclaration > ClassDeclaration > ClassBody > PropertyDefinition:not([key.type="PrivateIdentifier"])',
  'ExportDefaultDeclaration > ClassDeclaration > ClassBody > PropertyDefinition:not([key.type="PrivateIdentifier"])'
]

export default [
  ...config,
  { ignores: ['.test-dist/**', 'dist/**', 'src/generated/**'] },
  {
    files: publicApiFiles,
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          contexts: publicTypeContexts,
          publicOnly: true,
          require: { ClassDeclaration: true, FunctionDeclaration: true, MethodDefinition: true }
        }
      ]
    }
  }
]
