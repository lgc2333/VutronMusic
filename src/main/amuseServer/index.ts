import cors from '@fastify/cors'
import { BrowserWindow, ipcMain } from 'electron'
import fastify, { FastifyInstance } from 'fastify'

import { randomAlNum } from '../utils/utils'

export type LikeStatus = 'INDIFFERENT' | 'LIKE' | 'DISLIKE'

export type RepeatType = 'NONE' | 'ALL' | 'ONE'

export interface PlayerInfo {
  hasSong: boolean
  isPaused: boolean
  volumePercent: number
  seekbarCurrentPosition: number
  seekbarCurrentPositionHuman: string
  statePercent: number
  likeStatus: string
  repeatType: string
}

export interface TrackInfo {
  author: string
  title: string
  album: string
  cover: string
  duration: number
  durationHuman: string
  url: string
  id: string
  isVideo: boolean
  isAdvertisement: boolean
  inLibrary: boolean
}

export interface AmuseInfo {
  player: PlayerInfo
  track: TrackInfo
}

export interface AmuseInfoGetter {
  get(): Promise<AmuseInfo>
}

export const notImplementedInfoGetter: AmuseInfoGetter = {
  async get() {
    throw new Error('Not implemented')
  }
}

export class MainWindowAmuseInfoGetter {
  constructor(
    protected mainWindow: BrowserWindow,
    public timeout = 1000
  ) {}

  get(): Promise<AmuseInfo> {
    const currentEcho = randomAlNum(8)
    this.mainWindow.webContents.send('queryAmuseInfo', currentEcho)
    return new Promise((resolve, reject) => {
      const rejectTimeout = setTimeout(() => {
        reject(new Error('Timeout'))
      }, this.timeout)
      ipcMain.on('queryAmuseInfoReturn', (_, info: AmuseInfo, echo: string) => {
        if (currentEcho === echo) {
          resolve(info)
          clearTimeout(rejectTimeout)
        }
      })
    })
  }
}

export const amuseDefaultPort = 9863

export class AmuseServerManager {
  public instance: FastifyInstance | null = null

  constructor(
    public infoGetter: AmuseInfoGetter,
    public port: number = amuseDefaultPort
  ) {}

  async createInstance() {
    const server = fastify({
      ignoreTrailingSlash: true
    })
    await server.register(cors, { origin: '*' })
    await server.register(async (fastify) => {
      fastify.get('/query', async () => {
        return this.infoGetter.get()
      })
    })
    return server
  }

  async restart() {
    if (this.instance) {
      const server = this.instance
      this.instance = null
      await server.close()
    }
    this.instance = await this.createInstance()
    await this.instance.listen({ port: this.port })
    console.log(`AmuseServer is running at http://localhost:${this.port}`)
  }
}
