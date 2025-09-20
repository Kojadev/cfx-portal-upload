import { Browser, getInstalledBrowsers, install } from '@puppeteer/browsers'
import { SearchResponse, Urls, BuildOptions, ZipPaths } from './types'
import { homedir } from 'os'
import { join } from 'path'

import * as core from '@actions/core'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import yazl from 'yazl'

/**
 * Get the cache directory for Puppeteer.
 * @returns {string} The cache directory.
 */
function getCacheDirectory(): string {
  return join(homedir(), '.cache', 'puppeteer')
}

/**
 * Prepare the Puppeteer environment by installing the necessary browser.
 * @returns {Promise<void>} Resolves when the environment is prepared.
 */
export async function preparePuppeteer(): Promise<void> {
  // Skip custom Chrome installation - use system Chrome
  core.info('Using system Chrome installation...')
  return
}

export async function resolveAssetId(
  name: string,
  cookies: string
): Promise<string> {
  core.info(`🔍 Searching for asset: "${name}"`)

  try {
    const search = await axios.get<SearchResponse>(
      `https://portal-api.cfx.re/v1/me/assets?search=${name}&sort=asset.name&direction=asc`,
      {
        headers: {
          Cookie: cookies
        }
      }
    )

    core.info(`📊 Found ${search.data.items.length} assets matching search`)

    if (search.data.items.length == 0) {
      core.error(`❌ No assets found matching: "${name}"`)
      core.error(
        '💡 Make sure the asset exists in your CFX Portal and the name is correct'
      )
      throw new Error(
        `No assets found matching "${name}". Check if the asset exists in your CFX Portal.`
      )
    }

    // Log all found assets for debugging
    core.info('📋 Available assets:')
    search.data.items.forEach((asset: any) => {
      core.info(`  - "${asset.name}" (ID: ${asset.id})`)
    })

    // Match the exact name
    for (const asset of search.data.items) {
      if (asset.name === name) {
        core.info(`✅ Found exact match: "${asset.name}" (ID: ${asset.id})`)
        return asset.id.toString()
      }
    }

    // If no exact match, suggest alternatives
    const suggestions = search.data.items
      .map((asset: any) => `"${asset.name}"`)
      .join(', ')
    core.error(`❌ No exact match found for "${name}"`)
    core.error(`💡 Available assets: ${suggestions}`)

    throw new Error(
      `No exact match found for "${name}". Available assets: ${suggestions}`
    )
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) {
        throw new Error(
          'Authentication failed. Check if your forum cookie is valid.'
        )
      } else if (error.response?.status === 403) {
        throw new Error(
          'Access denied. Make sure you have permission to view assets.'
        )
      }
      core.error(
        `API Error: ${error.response?.status} ${error.response?.statusText}`
      )
    }
    throw error
  }
}

export function getUrl(type: keyof typeof Urls, id?: string): string {
  const url = Urls.API + Urls[type]
  return id ? url.replace('{id}', id) : url
}

type TreeNode = string | Record<string, TreeNode[]> | null

function buildTree(currentPath: string): TreeNode {
  const stats = fs.statSync(currentPath)

  if (stats.isFile()) {
    return path.basename(currentPath) // Return file name
  }

  if (stats.isDirectory()) {
    const children = fs.readdirSync(currentPath)
    return {
      [path.basename(currentPath)]: children.map((child: string) =>
        buildTree(path.join(currentPath, child))
      )
    }
  }

  return null
}

export function getEnv(name: string): string {
  if (process.env[name] === undefined) {
    throw new Error(`Environment variable ${name} is not set.`)
  }

  return process.env[name]
}

export async function zipAsset(assetName: string): Promise<string> {
  core.debug('Zipping asset...')

  const workspacePath = getEnv('GITHUB_WORKSPACE')
  const outputZipPath = assetName + '.zip'
  const zipfile = new yazl.ZipFile()

  function addDirectoryToZip(dir: string, zipPath: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const entryZipPath = path.join(zipPath, entry.name)
      if (entry.isDirectory()) {
        core.debug(`Entering directory ${fullPath}...`)
        addDirectoryToZip(fullPath, entryZipPath)
      } else if (entry.isFile()) {
        core.debug(`Adding file ${fullPath} as ${entryZipPath}...`)
        zipfile.addFile(fullPath, entryZipPath, { compress: true })
      }
    }
  }

  core.debug('Adding files to zip...')
  addDirectoryToZip(workspacePath, assetName) // Use asset name as zip root folder

  core.debug(
    'Zip content: ' + JSON.stringify(buildTree(workspacePath), null, 2)
  )
  zipfile.end()

  const outputStream = fs.createWriteStream(outputZipPath)
  return new Promise((resolve, reject) => {
    zipfile.outputStream
      .pipe(outputStream)
      .on('close', () => {
        console.log(`Asset zipped to ${outputZipPath}`)
        resolve(path.resolve(outputZipPath))
      })
      .on('error', reject)
  })
}

export function deleteIfExists(_path: string): void {
  _path = path.join(getEnv('GITHUB_WORKSPACE'), _path)

  try {
    if (fs.existsSync(_path)) {
      core.debug(`Deleting ${_path}...`)
      const stats = fs.lstatSync(_path)

      if (stats.isDirectory()) {
        fs.rmSync(_path, { recursive: true, force: true })
      } else if (stats.isFile()) {
        fs.unlinkSync(_path)
      }
    } else {
      core.debug(`${_path} does not exist, skipping`)
    }
  } catch (error) {
    core.debug(`Skipping ${_path} deletion due to error: ${error as string}`)
  }
}

/**
 * Builds web and DUI if they exist
 */
async function buildWebAndDui(): Promise<void> {
  const workspacePath = getEnv('GITHUB_WORKSPACE')

  // Build web if exists
  const webPath = path.join(workspacePath, 'web')
  if (fs.existsSync(webPath)) {
    core.info('Building web...')
    const { spawn } = require('child_process')

    await new Promise<void>((resolve, reject) => {
      const buildProcess = spawn('pnpm', ['install'], {
        cwd: webPath,
        stdio: 'inherit',
        shell: true
      })

      buildProcess.on('close', (code: number | null) => {
        if (code === 0) {
          const buildCmd = spawn('pnpm', ['build'], {
            cwd: webPath,
            stdio: 'inherit',
            shell: true
          })

          buildCmd.on('close', (buildCode: number | null) => {
            if (buildCode === 0) {
              core.info('Web build completed successfully')
              resolve()
            } else {
              reject(new Error(`Web build failed with code ${buildCode}`))
            }
          })
        } else {
          reject(new Error(`Web install failed with code ${code}`))
        }
      })
    })
  }

  // Build DUI if exists
  const duiPath = path.join(workspacePath, 'dui')
  if (fs.existsSync(duiPath)) {
    core.info('Building DUI...')
    const { spawn } = require('child_process')

    await new Promise<void>((resolve, reject) => {
      const installProcess = spawn('pnpm', ['install'], {
        cwd: duiPath,
        stdio: 'inherit',
        shell: true
      })

      installProcess.on('close', (code: number | null) => {
        if (code === 0) {
          const buildCmd = spawn('pnpm', ['build'], {
            cwd: duiPath,
            stdio: 'inherit',
            shell: true
          })

          buildCmd.on('close', (buildCode: number | null) => {
            if (buildCode === 0) {
              // Copy DUI build files
              const duiBuildPath = path.join(duiPath, 'build')
              const targetDuiBuildPath = path.join(
                workspacePath,
                'dui',
                'build'
              )

              if (fs.existsSync(duiBuildPath)) {
                if (!fs.existsSync(targetDuiBuildPath)) {
                  fs.mkdirSync(targetDuiBuildPath, { recursive: true })
                }
                copyRecursively(duiBuildPath, targetDuiBuildPath)
              }

              core.info('DUI build completed successfully')
              resolve()
            } else {
              reject(new Error(`DUI build failed with code ${buildCode}`))
            }
          })
        } else {
          reject(new Error(`DUI install failed with code ${code}`))
        }
      })
    })
  }
}

/**
 * Creates escrowed version of the asset
 * @param assetName The name of the asset
 * @param ignoreFiles Optional array of files to ignore in escrow
 * @returns Path to the escrowed zip file
 */
export async function createEscrowedVersion(
  assetName: string,
  ignoreFiles?: string[]
): Promise<string> {
  core.info('Creating escrowed version...')

  // Build web and DUI first
  await buildWebAndDui()

  const workspacePath = getEnv('GITHUB_WORKSPACE')
  const escrowedDir = path.join(workspacePath, 'escrowed')

  // Create escrowed directory structure
  await createDirectory(escrowedDir)
  await createDirectory(path.join(escrowedDir, 'web', 'build'))

  // Copy main folders and files
  const foldersToInclude = ['client', 'shared', 'locales', 'server']
  const filesToInclude = ['fxmanifest.lua', 'init.lua']

  for (const folder of foldersToInclude) {
    const srcPath = path.join(workspacePath, folder)
    if (fs.existsSync(srcPath)) {
      copyRecursively(srcPath, path.join(escrowedDir, folder))
    }
  }

  for (const file of filesToInclude) {
    const srcPath = path.join(workspacePath, file)
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(escrowedDir, file))
    }
  }

  // Copy web/build if exists
  const webBuildPath = path.join(workspacePath, 'web', 'build')
  if (fs.existsSync(webBuildPath)) {
    copyRecursively(webBuildPath, path.join(escrowedDir, 'web', 'build'))
  }

  // Add escrow ignore configuration to fxmanifest.lua
  const fxmanifestPath = path.join(escrowedDir, 'fxmanifest.lua')
  if (fs.existsSync(fxmanifestPath)) {
    const filesToIgnore = ignoreFiles || [
      'init.lua',
      'shared/config.lua',
      'shared/utils.lua',
      'shared/startheist.lua'
    ]
    const ignoreEntries = filesToIgnore
      .map((file: string) => `  '${file}',`)
      .join('\n')
    const escrowIgnore = `\nescrow_ignore {\n${ignoreEntries}\n}\n`
    fs.appendFileSync(fxmanifestPath, escrowIgnore)
  }

  // Create zip
  const zipPath = `${assetName}-escrowed.zip`
  return await zipDirectory(escrowedDir, zipPath, assetName)
}

/**
 * Creates open source version of the asset
 * @param assetName The name of the asset
 * @returns Path to the open source zip file
 */
export async function createOpenSourceVersion(
  assetName: string
): Promise<string> {
  core.info('Creating open-source version...')

  // Build web and DUI first (if not already built)
  await buildWebAndDui()

  const workspacePath = getEnv('GITHUB_WORKSPACE')
  const openSourceDir = path.join(workspacePath, 'open-source')

  // Create open-source directory structure
  await createDirectory(openSourceDir)
  await createDirectory(path.join(openSourceDir, 'web'))

  // Copy main folders and files
  const foldersToInclude = ['client', 'shared', 'locales', 'server']
  const filesToInclude = ['fxmanifest.lua', 'init.lua']

  for (const folder of foldersToInclude) {
    const srcPath = path.join(workspacePath, folder)
    if (fs.existsSync(srcPath)) {
      copyRecursively(srcPath, path.join(openSourceDir, folder))
    }
  }

  for (const file of filesToInclude) {
    const srcPath = path.join(workspacePath, file)
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(openSourceDir, file))
    }
  }

  // Copy entire web folder except node_modules
  const webPath = path.join(workspacePath, 'web')
  if (fs.existsSync(webPath)) {
    copyRecursively(webPath, path.join(openSourceDir, 'web'), ['node_modules'])
  }

  // Add escrow ignore configuration to fxmanifest.lua (ignores everything for open source)
  const fxmanifestPath = path.join(openSourceDir, 'fxmanifest.lua')
  if (fs.existsSync(fxmanifestPath)) {
    const escrowIgnore = `
escrow_ignore {
  '/*',
  '/**/*',
  '/**/**/*',
}
`
    fs.appendFileSync(fxmanifestPath, escrowIgnore)
  }

  // Create zip
  const zipPath = `${assetName}-source.zip`
  return await zipDirectory(openSourceDir, zipPath, assetName)
}

/**
 * Creates directory recursively
 * @param dirPath Path to directory
 */
async function createDirectory(dirPath: string): Promise<void> {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

/**
 * Copies files and directories recursively
 * @param src Source path
 * @param dest Destination path
 * @param excludeDirs Directories to exclude
 */
function copyRecursively(
  src: string,
  dest: string,
  excludeDirs: string[] = []
): void {
  const stats = fs.statSync(src)

  if (stats.isDirectory()) {
    if (excludeDirs.includes(path.basename(src))) {
      return
    }

    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true })
    }

    const entries = fs.readdirSync(src)
    for (const entry of entries) {
      if (excludeDirs.includes(entry)) {
        continue
      }
      copyRecursively(
        path.join(src, entry),
        path.join(dest, entry),
        excludeDirs
      )
    }
  } else if (stats.isFile()) {
    fs.copyFileSync(src, dest)
  }
}

/**
 * Creates a zip file from a directory
 * @param sourceDir Source directory to zip
 * @param zipPath Output zip file path
 * @param rootFolderName Name of the root folder in the zip
 * @returns Promise resolving to the absolute path of the created zip file
 */
async function zipDirectory(
  sourceDir: string,
  zipPath: string,
  rootFolderName: string
): Promise<string> {
  const zipfile = new yazl.ZipFile()
  const outputZipPath = path.resolve(zipPath)

  function addDirectoryToZip(dir: string, zipPath: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const entryZipPath = path.join(zipPath, entry.name)
      if (entry.isDirectory()) {
        addDirectoryToZip(fullPath, entryZipPath)
      } else if (entry.isFile()) {
        zipfile.addFile(fullPath, entryZipPath, { compress: true })
      }
    }
  }

  addDirectoryToZip(sourceDir, rootFolderName)
  zipfile.end()

  const outputStream = fs.createWriteStream(outputZipPath)
  return new Promise((resolve, reject) => {
    zipfile.outputStream
      .pipe(outputStream)
      .on('close', () => {
        core.info(`Directory zipped to ${outputZipPath}`)
        resolve(outputZipPath)
      })
      .on('error', reject)
  })
}

/**
 * Creates both escrowed and open source versions based on options
 * @param options Build options
 * @param assetName Base asset name
 * @returns Object containing paths to created zip files
 */
export async function createVersions(
  options: BuildOptions,
  assetName: string
): Promise<ZipPaths> {
  const zipPaths: ZipPaths = {}

  // Clean up before building
  deleteIfExists('escrowed/')
  deleteIfExists('open-source/')

  if (options.createEscrowed) {
    const escrowIgnoreFiles =
      options.escrowedConfig?.escrow_ignore || options.escrowedIgnoreFiles
    const escrowedName =
      options.escrowedConfig?.asset_name ||
      options.escrowedAssetName ||
      `${assetName}-escrowed`

    zipPaths.escrowed = await createEscrowedVersion(
      escrowedName,
      escrowIgnoreFiles
    )
  }

  if (options.createOpenSource) {
    zipPaths.openSource = await createOpenSourceVersion(
      options.openSourceAssetName || `${assetName}-source`
    )
  }

  return zipPaths
}
