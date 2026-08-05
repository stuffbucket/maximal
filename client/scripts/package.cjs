const { initializeProxy } = require('@electron/get')
const { api } = require('@electron-forge/core')

initializeProxy()

const arg = process.argv.find((value) => value.startsWith('--arch='))
const arch = arg?.slice('--arch='.length) || process.env.ARCH || 'arm64'

api
  .package({
    dir: process.cwd(),
    interactive: true,
    arch,
    platform: 'darwin',
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
