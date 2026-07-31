import config from '@swarmmachina/standards/eslint-typescript'

export default [...config, { ignores: ['.test-dist/**', 'dist/**', 'src/generated/**'] }]
