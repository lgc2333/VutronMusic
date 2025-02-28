import { app, ipcMain, shell, IpcMainEvent, dialog, BrowserWindow, globalShortcut } from 'electron'
import { YPMTray } from './tray'
import { MprisImpl } from './mpris'
// import { createDBus, signalNameEnum } from './dbusService'
import { createDBus } from './dbusClient'
import Constants from './utils/Constants'
import store from './store'
import fs from 'fs'
import path from 'path'
import { parseFile } from 'music-metadata'
import cache from './cache'
import navidrome from './streaming/navidrome'
import emby from './streaming/emby'
import { db, Tables } from './db'
import { CacheAPIs } from './utils/CacheApis'
import { createMD5, deleteExcessCache, getReplayGainFromMetadata, splitArtist } from './utils/utils'
import { registerGlobalShortcuts } from './globalShortcut'
import { createMenu } from './menu'

let isLock = store.get('osdWindow.isLock') as boolean
/*
 * IPC Communications
 * */
export default class IPCs {
  static initialize(
    win: BrowserWindow,
    tray: YPMTray,
    mpris: MprisImpl,
    lrc: Record<string, Function>
  ): void {
    initWindowIpcMain(win)
    initOSDWindowIpcMain(win, lrc)
    initTrayIpcMain(win, tray)
    initTaskbarIpcMain()
    initMprisIpcMain(win, mpris)
    initOtherIpcMain(win)
    initStreaming()
  }
}

function exitAsk(event: IpcMainEvent, win: BrowserWindow) {
  event.preventDefault()
  dialog
    .showMessageBox({
      type: 'info',
      title: 'Infomation',
      cancelId: 2,
      defaultId: 0,
      message: '确定要关闭吗？',
      buttons: ['最小化到托盘', '直接退出'],
      checkboxLabel: '记住我的选择'
    })
    .then((result) => {
      if (result.checkboxChecked && result.response !== 2) {
        win.webContents.send(
          'rememberCloseAppOption',
          result.response === 0 ? 'minimizeToTray' : 'exit'
        )
      }
      if (result.response === 0) {
        event.preventDefault()
        win.hide()
      } else if (result.response === 1) {
        setTimeout(() => {
          win = null
          app.exit()
        }, 100)
      }
    })
    .catch()
}

function initWindowIpcMain(win: BrowserWindow): void {
  ipcMain.on('minimize', (event: IpcMainEvent) => {
    win.minimize()
  })

  ipcMain.handle('maximizeOrUnmaximize', (event: IpcMainEvent) => {
    win.isMaximized() ? win.unmaximize() : win.maximize()
    return !win.isMaximized()
  })

  ipcMain.on('close', (event: IpcMainEvent) => {
    const closeAppOption = store.get('settings.closeAppOption') || 'ask'
    if (closeAppOption === 'exit') {
      win = null
      app.exit()
    } else if (closeAppOption === 'minimizeToTray') {
      event.preventDefault()
      win.hide()
    } else {
      exitAsk(event, win)
    }
  })
}

function initTrayIpcMain(win: BrowserWindow, tray: YPMTray): void {
  ipcMain.on(
    'updateTray',
    (event: IpcMainEvent, data: { img: string; width: number; height: number }) => {
      tray.updateTray(data.img, data.width, data.height)
    }
  )
  ipcMain.on('showWindow', () => {
    win.show()
  })

  ipcMain.on('updatePlayerState', (event: IpcMainEvent, data: any) => {
    for (const [key, value] of Object.entries(data) as [string, any]) {
      if (key === 'playing') {
        tray.setPlayState(value)
      } else if (key === 'repeatMode') {
        tray.setRepeatMode(value)
      } else if (key === 'shuffle') {
        tray.setShuffleMode(value)
      } else if (key === 'like') {
        tray.setLikeState(value)
      }
    }
  })

  ipcMain.on('setStoreSettings', (event: IpcMainEvent, data: any) => {
    for (const [key, value] of Object.entries(data) as [string, any]) {
      store.set(`settings.${key}`, value)
      if (key === 'enableTrayMenu') {
        tray.setContextMenu(Constants.IS_MAC ? value : true)
      } else if (key === 'lang') {
        const showMenu = Constants.IS_MAC ? (store.get('settings.enableTrayMenu') as boolean) : true
        tray.setContextMenu(showMenu)
      } else if (key === 'enableGlobalShortcut') {
        if (value) {
          registerGlobalShortcuts(win)
        } else {
          globalShortcut.unregisterAll()
        }
      } else if (key === 'shortcuts') {
        createMenu(win)
      }
    }
  })

  ipcMain.on('updateOsdState', (event, data) => {
    const [key, value] = Object.entries(data)[0] as [string, any]
    if (key === 'show') {
      tray.setShowOSD(value)
    } else if (key === 'isLock') {
      tray.setOSDLock(value)
    }
  })
}

function initOSDWindowIpcMain(win: BrowserWindow, lrc: { [key: string]: Function }): void {
  ipcMain.on('updateLyricInfo', (event, data) => {
    lrc.updateLyricInfo(data)
  })
  ipcMain.on('updateOsdState', (event, data) => {
    const [key, value] = Object.entries(data)[0] as [string, any]
    store.set(`osdWin.${key}`, value)
    if (key === 'show') {
      lrc.toggleOSDWindow()
    } else if (key === 'type') {
      lrc.switchOSDWindow(value)
    } else if (key === 'isLock') {
      isLock = value
      // 当设置鼠标忽略时，同时设置窗口置顶，避免窗口不位于最上层而导致无法点击
      store.set('osdWin.isAlwaysOnTop', value)
      lrc.toggleMouseIgnore()
    }
  })
  ipcMain.on('from-osd', (event, message: string) => {
    if (message === 'showMainWin') {
      win.show()
    } else if (message === 'playPrev') {
      win.webContents.send('previous')
    } else if (message === 'playNext') {
      win.webContents.send('next')
    } else if (message === 'playOrPause') {
      win.webContents.send('play')
    }
  })
  ipcMain.on('osd-resize', (event, height) => {
    lrc.updateOsdHeight(height)
  })
  ipcMain.on('updatePlayerState', (event: IpcMainEvent, data: any) => {
    for (const [key, value] of Object.entries(data) as [string, any]) {
      if (key === 'playing') {
        lrc.updateOSDPlayingState(value)
      }
    }
  })
  ipcMain.on('set-ignore-mouse', (event, ignore) => {
    store.set('osdWin.isLock', ignore)
    lrc.toggleMouseIgnore()
  })
  ipcMain.on('mouseleave', () => {
    store.set('osdWin.isLock', isLock)
    lrc.toggleMouseIgnore()
  })
  ipcMain.on('window-drag', (event, data: any) => {
    lrc.dragOsdWindow(data)
  })
  ipcMain.on('windowMouseleave', () => {
    lrc.windowMouseleave()
  })
}

function initTaskbarIpcMain(): void {}

function initOtherIpcMain(win: BrowserWindow): void {
  // Get application version
  ipcMain.handle('msgRequestGetVersion', () => {
    return Constants.APP_VERSION
  })

  // Open url via web browser
  ipcMain.on('msgOpenExternalLink', async (event: IpcMainEvent, url: string) => {
    await shell.openExternal(url)
  })

  // Open file
  ipcMain.handle('msgOpenFile', async (event, filter: string) => {
    const filters = []
    if (filter === 'text') {
      filters.push({ name: 'Text', extensions: ['txt', 'json'] })
    } else if (filter === 'zip') {
      filters.push({ name: 'Zip', extensions: ['zip'] })
    }
    const dialogResult = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters
    })
    return dialogResult
  })

  ipcMain.handle('msgCheckFileExist', (event, path: string) => {
    try {
      fs.accessSync(path, fs.constants.F_OK)
      return true
    } catch (e) {
      return false
    }
  })

  ipcMain.handle('selecteFolder', async (event) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    if (!result.canceled) {
      return result.filePaths[0]
    }
    return null
  })

  ipcMain.handle('getLocalMusic', (event) => {
    const { songs } = cache.get(CacheAPIs.LocalMusic)
    const playlists = cache.get(CacheAPIs.LocalPlaylist)
    return { songs, playlists }
  })

  ipcMain.handle('upsertLocalPlaylist', async (event, playlist: object) => {
    const result = await cache.set(CacheAPIs.LocalPlaylist, playlist)
    return result
  })

  ipcMain.on('clearDeletedMusic', (event) => {
    const { songs } = cache.get(CacheAPIs.LocalMusic)
    const deletedTracks = []
    if (songs.length === 0) return
    for (let i = songs.length - 1; i >= 0; i--) {
      const track = songs[i]
      try {
        fs.accessSync(track.filePath, fs.constants.F_OK)
      } catch (e) {
        deletedTracks.push(track.id)
      }
    }

    if (deletedTracks.length > 0) {
      try {
        db.deleteMany(Tables.Track, deletedTracks)
        win.webContents.send('msgDeletedTracks', deletedTracks)
      } catch (e) {
        console.log(e)
      }
    }
  })

  ipcMain.on('msgScanLocalMusic', async (event, filePath: string) => {
    const musicFileExtensions = /\.(mp3|aiff|flac|alac|m4a|aac|wav)$/i

    const { songs } = cache.get(CacheAPIs.LocalMusic)
    const albums = songs.map((track: any) => track.album)
    const artists = songs.map((track: any) => track.artists).flat()
    const newTracks = []
    const newAlbums = []
    const newArtists = []

    const walk = async (dir: string) => {
      const files = fs.readdirSync(dir)
      for (const file of files) {
        const filePath = path.join(dir, file)
        const stat = fs.statSync(filePath)

        if (stat.isFile() && musicFileExtensions.test(filePath)) {
          const foundtrack = songs.find((track) => track.filePath === filePath)
          if (!foundtrack) {
            const md5 = createMD5(filePath)
            const metadata = await parseFile(filePath)
            const birthDate = new Date(stat.birthtime).getTime()
            const { common, format } = metadata

            // 获取艺术家信息
            const arIDsResult: any[] = []
            const arts = splitArtist(common.albumartist ?? common.artist)
            for (const art of arts) {
              const foundArtist = [...artists, ...newArtists].find((artist) => artist.name === art)
              if (foundArtist) {
                arIDsResult.push(foundArtist)
              } else {
                const artist = {
                  id: artists.length + newArtists.length + 1,
                  name: art,
                  matched: false,
                  picUrl: 'https://p1.music.126.net/VnZiScyynLG7atLIZ2YPkw==/18686200114669622.jpg'
                }
                arIDsResult.push(artist)
                newArtists.push(artist)
              }
            }

            // 获取专辑信息
            let album = [...albums, ...newAlbums].find((album) => album.name === common.album)
            if (!album) {
              album = {
                id: albums.length + newAlbums.length + 1,
                name: common.album ?? '未知专辑',
                matched: false,
                picUrl: 'atom://get-default-pic'
              }
              newAlbums.push(album)
            }

            // 获取音乐信息
            const track = {
              id: songs.length + newTracks.length + 1,
              name: common.title ?? getFileName(filePath) ?? '错误文件',
              dt: (format.duration ?? 0) * 1000,
              source: 'localTrack',
              gain: getReplayGainFromMetadata(metadata),
              peak: 1,
              br: format.bitrate ?? 320000,
              filePath,
              type: 'local',
              matched: false,
              offset: 0,
              md5,
              createTime: birthDate,
              alias: [],
              album,
              artists: arIDsResult,
              picUrl: 'atom://get-default-pic'
            }
            // const currentArtists = [...artists, ...newArtists].filter((artist) => arIDsResult.includes(artist.id))
            win.webContents.send('msgHandleScanLocalMusic', { track })
            newTracks.push(track)
          }
        } else if (stat.isDirectory()) {
          await walk(filePath)
        }
      }
    }
    await walk(filePath)
    if (newTracks.length > 0) cache.set(CacheAPIs.LocalMusic, { newTracks })
    win.webContents.send('scanLocalMusicDone')
  })

  ipcMain.on('msgShowInFolder', (event, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.on('deleteLocalMusicDB', (event) => {
    const trackIDs = cache.get(CacheAPIs.LocalMusic)?.songs.map((track: any) => track.id)
    if (!trackIDs.length) return
    db.deleteMany(Tables.Track, trackIDs)

    const playlistIDs = cache.get(CacheAPIs.LocalPlaylist)?.map((playlist) => playlist.id)
    if (!playlistIDs.length) return
    db.deleteMany(Tables.Playlist, playlistIDs)
    // db.vacuum()
  })

  ipcMain.handle('clearCacheTracks', (event) => {
    const result = deleteExcessCache(true)
    return result
  })

  ipcMain.handle('getCacheTracksInfo', (event) => {
    const tracks = cache.get(CacheAPIs.LocalMusic, { sql: "type = 'online'" })
    const size = tracks.songs
      .map((track: any) => track.size)
      .reduce((acc: string, cur: string) => Number(acc) + Number(cur), 0)
    return { length: tracks.songs.length, size }
  })

  ipcMain.handle('accurateMatch', (event, track, id) => {
    const data = { result: { songs: [track] } }
    const result = cache.set(CacheAPIs.searchMatch, data, { localID: id })
    return result
  })

  ipcMain.handle('updateLocalTrackInfo', (event, trackId: number, data: any) => {
    const result = cache.set(CacheAPIs.Track, data, { id: trackId })
    return result
  })

  ipcMain.handle('deleteLocalPlaylist', (event, pid: number) => {
    try {
      db.delete(Tables.Playlist, pid)
      return true
    } catch (error) {
      return false
    }
  })

  ipcMain.handle('logout', (event, uid: string) => {
    try {
      db.delete(Tables.AccountData, uid)
      return true
    } catch (error) {
      return false
    }
  })
}

async function initMprisIpcMain(win: BrowserWindow, mpris: MprisImpl): Promise<void> {
  if (!Constants.IS_LINUX || !mpris) return

  // 下面这一段注释请勿删除。它是本程序作为插件歌词服务端的实现方式，可供以后参考。
  // 目前插件和本程序所采用的实现方式是：插件为服务端，本程序为客户端。

  // const dbus = createDBus(win)
  // ipcMain.on('updateCurrentLyric', (event, data) => {
  //   dbus.iface?.emit(signalNameEnum.currentLrc, data)
  // })

  const busName = 'org.gnome.Shell.TrayLyric'
  const dbus = createDBus(busName, win)

  ipcMain.handle('askExtensionStatus', async (event) => {
    return dbus.status
  })

  ipcMain.on('updateLyricInfo', (event: IpcMainEvent, data: any) => {
    const [key, value] = Object.entries(data)[0] as [string, any]
    if (key === 'currentLyric') {
      value.sender = 'VutronMusic'
      dbus.iface?.UpdateLyric(JSON.stringify(value))
    }
  })

  ipcMain.on('metadata', (event: IpcMainEvent, metadata: any) => {
    mpris?.setMetadata(metadata)
  })
  ipcMain.on('updatePlayerState', (event: IpcMainEvent, data: any) => {
    for (const [key, value] of Object.entries(data) as [string, any]) {
      if (key === 'playing') {
        mpris?.setPlayState(value)
      } else if (key === 'repeatMode') {
        mpris?.setRepeatMode(value)
      } else if (key === 'shuffle') {
        mpris?.setShuffleMode(value)
      } else if (key === 'like') {
        // dbus.iface?.LikeThisTrack(value)
        // dbus.iface?.emit(signalNameEnum.updateLikeStatus, value)
      } else if (key === 'isPersonalFM') {
        mpris?.setPersonalFM(value)
      }
    }
  })
  ipcMain.on('playerCurrentTrackTime', (event: IpcMainEvent, progress: number) => {
    mpris?.setPosition(progress)
  })
}

function initStreaming() {
  ipcMain.handle('stream-login', async (event: IpcMainEvent, data: any) => {
    const { platform } = data
    store.set('accounts.selected', platform)
    store.set(`accounts.${data.platform}.url`, data.baseURL)
    store.set(`accounts.${data.platform}.username`, data.username)
    store.set(`accounts.${data.platform}.password`, data.password)
    if (platform === 'navidrome') {
      const response = await navidrome.doLogin(data.baseURL, data.username, data.password)
      return response
    } else if (platform === 'emby') {
      const response = await emby.doLogin(data.baseURL, data.username, data.password)
      return response
    }
  })

  ipcMain.handle('get-stream-songs', async (event, data) => {
    store.set('accounts.selected', data.platform)
    if (data.platform === 'navidrome') {
      const tracks = await navidrome.getTracks()
      const playlists = await navidrome.getPlaylists()
      return {
        code: tracks.code,
        message: tracks.message,
        tracks: tracks.data,
        playlists: playlists.data
      }
    } else if (data.platform === 'emby') {
      const tracks = await emby.getTracks()
      const playlists = await emby.getPlaylists()
      return { code: tracks.code, message: '', tracks: tracks.data, playlists: playlists.data }
    }
  })

  ipcMain.handle('get-stream-account', (event, data) => {
    const url = (store.get(`accounts.${data.platform}.url`) as string) || ''
    const username = (store.get(`accounts.${data.platform}.username`) as string) || ''
    const password = (store.get(`accounts.${data.platform}.password`) as string) || ''
    return { url, username, password }
  })

  ipcMain.handle('get-stream-playlists', async (event, data) => {
    if (data.platform === 'navidrome') {
      const playlists = await navidrome.getPlaylists()
      return { code: playlists.code, playlists: playlists.data }
    } else if (data.platform === 'emby') {
      const playlists = await emby.getPlaylists()
      return { code: playlists.code, playlists: playlists.data }
    }
  })

  ipcMain.handle('logoutStreamMusic', (event, data) => {
    if (data.platform === 'navidrome') {
      store.set('accounts.navidrome.clientID', '')
      store.set('accounts.navidrome.anthorization', '')
      store.set('accounts.navidrome.token', '')
      store.set('accounts.navidrome.salt', '')
      return true
    } else if (data.platform === 'emby') {
      store.set('accounts.emby.userId', '')
      store.set('accounts.emby.accessToken', '')
      return true
    }
  })

  ipcMain.handle('deleteStreamPlaylist', async (event, data) => {
    if (data.platform === 'navidrome') {
      const result = await navidrome.deletePlaylist(data.id)
      return result
    } else if (data.platform === 'emby') {
      const result = await emby.deletePlaylist(data.id)
      return result
    }
  })

  ipcMain.handle('createStreamPlaylist', async (event, data) => {
    if (data.platform === 'navidrome') {
      const result = await navidrome.createPlaylist(data.name)
      return result
    } else if (data.platform === 'emby') {
      const result = await emby.createPlaylist(data.name)
      return result
    }
  })

  ipcMain.handle('updateStreamPlaylist', async (event, data) => {
    if (data.platform === 'navidrome') {
      const result = await navidrome.addTracksToPlaylist(data.op, data.playlistId, data.ids)
      return result
    } else if (data.platform === 'emby') {
      const result = await emby.addTracksToPlaylist(data.op, data.playlistId, data.ids)
      return result
    }
  })

  ipcMain.on('scrobbleStreamMusic', (event, data) => {
    if (data.platform === 'navidrome') {
      navidrome.scrobble(data.id)
    } else if (data.platform === 'emby') {
      emby.scrobble(data.id)
    }
  })

  ipcMain.handle('likeAStreamTrack', async (event, data) => {
    if (data.platform === 'navidrome') {
      const result = await navidrome.likeATrack(data.operation, data.id)
      return result
    } else if (data.platform === 'emby') {
      const result = await emby.likeATrack(data.operation, data.id)
      return result
    }
  })
}

function getFileName(filePath: string) {
  const fileExt = path.extname(filePath)
  const fileNameWithExt = path.basename(filePath)
  const fileName = fileNameWithExt.replace(fileExt, '')
  return fileName
}
