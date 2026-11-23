exports.version = 1.1
exports.apiRequired = 8.85
exports.description = "Auto backup descript.ion files"
exports.repo = "hugo529100/hfs-Descripts-Backup"

exports.config = {
    maxBackups: {
        type: 'number',
        defaultValue: 10,
        min: 1,
        max: 99,
        label: "Max Backups",
        description: "Number of backups to keep"
    }
}

exports.init = async api => {

    const fs = api.require("fs/promises")
    const fsSync = api.require("fs")
    const path = api.require("path")
    const crypto = api.require("crypto")

    const STATE_FILE = path.join(api.storageDir, "state.json")

    let state = {}
    let watchers = new Map()
    let checking = new Map()

    const MAX_WATCHERS = 3

    try {
        state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"))
    } catch {
        state = {}
    }

    async function saveState() {
        try {
            await fs.mkdir(api.storageDir, { recursive: true })
            await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8")
        } catch (e) {
            api.log("Save state error:", e)
        }
    }

    function timeString(d = new Date()) {
        const p = n => String(n).padStart(2, "0")
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" +
               p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    }

    async function getFileHash(filePath) {
        try {
            const content = await fs.readFile(filePath)
            return crypto.createHash('md5').update(content).digest('hex')
        } catch {
            return null
        }
    }

    async function copyFileRetry(src, dst) {
        try {
            await fs.copyFile(src, dst)
        } catch (e) {
            if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e
            await new Promise(r => setTimeout(r, 3000))
            await fs.copyFile(src, dst)
        }
    }

    async function backup(folder) {
        const descFile = path.join(folder, "descript.ion")
        
        let stat
        try {
            stat = await fs.stat(descFile)
        } catch {
            return
        }

        if (stat.size === 0) return

        const currentHash = await getFileHash(descFile)
        if (!currentHash) return

        if (state[descFile] === currentHash) return

        await new Promise(r => setTimeout(r, 300))

        const verifyHash = await getFileHash(descFile)
        if (verifyHash !== currentHash) {
            state[descFile] = verifyHash
            await saveState()
            return
        }

        const backupDir = path.join(folder, "cache", "descript_backup")
        await fs.mkdir(backupDir, { recursive: true })

        const backupFile = path.join(backupDir, timeString() + "_descript.ion")
        
        try {
            await copyFileRetry(descFile, backupFile)
            
            state[descFile] = currentHash
            await saveState()

            let files = await fs.readdir(backupDir)
            let backupFiles = files.filter(f => f.endsWith("_descript.ion")).sort()
            
            const maxBackups = api.getConfig('maxBackups') || 3
            while (backupFiles.length > maxBackups) {
                const oldFile = backupFiles.shift()
                try {
                    await fs.unlink(path.join(backupDir, oldFile))
                } catch {}
            }
            
        } catch (e) {
            if (e && (e.code === 'EBUSY' || e.code === 'EPERM')) return
            api.log("Backup error:", e)
        }
    }

    function removeWatcher(folder) {
        if (watchers.has(folder)) {
            watchers.get(folder).close()
            watchers.delete(folder)
        }
    }

    function setupWatcher(folder) {
        const descFile = path.join(folder, "descript.ion")
        
        try {
            fsSync.statSync(descFile)
        } catch {
            return
        }

        // 如果已达到最大监听数，移除最旧的（第一个）
        if (watchers.size >= MAX_WATCHERS) {
            const oldest = watchers.keys().next().value
            if (oldest) {
                removeWatcher(oldest)
            }
        }

        // 移除旧的监听器
        if (watchers.has(folder)) {
            watchers.get(folder).close()
            watchers.delete(folder)
        }

        // 创建新监听器
        const watcher = fsSync.watch(descFile, (eventType) => {
            if (eventType === 'change') {
                const now = Date.now()
                const last = checking.get(folder)
                if (last && now - last < 2000) return
                checking.set(folder, now)
                
                setTimeout(() => {
                    backup(folder).catch(api.log)
                }, 500)
            }
        })

        watchers.set(folder, watcher)
    }

    // 监听文件夹访问（被动备份）
    api.events.on('listDiskFolder', async ({ path: dirPath, ctx }) => {
        // 设置文件监听（主动备份）
        setupWatcher(dirPath)
        
        // 首次访问时执行一次备份
        await backup(dirPath)
    })

    // 清理资源
    process.on('exit', () => {
        for (const [folder, watcher] of watchers) {
            watcher.close()
        }
        watchers.clear()
    })

    return {
        async manualBackup(folder) {
            if (!folder) throw new Error('Folder path required')
            const resolvedPath = path.resolve(folder)
            await backup(resolvedPath)
            return `Backup completed for: ${resolvedPath}`
        },

        async getBackupList(folder) {
            if (!folder) throw new Error('Folder path required')
            const resolvedPath = path.resolve(folder)
            const backupDir = path.join(resolvedPath, "cache", "descript_backup")
            try {
                const files = await fs.readdir(backupDir)
                return files.filter(f => f.endsWith("_descript.ion")).sort()
            } catch {
                return []
            }
        },

        async getStatus(folder) {
            if (!folder) throw new Error('Folder path required')
            const resolvedPath = path.resolve(folder)
            const descFile = path.join(resolvedPath, "descript.ion")
            const backupDir = path.join(resolvedPath, "cache", "descript_backup")
            
            let status = {
                folder: resolvedPath,
                descExists: false,
                descSize: 0,
                hasBackup: false,
                backupCount: 0,
                backups: [],
                hasWatcher: watchers.has(folder)
            }

            try {
                const stat = await fs.stat(descFile)
                status.descExists = true
                status.descSize = stat.size
                status.hasBackup = !!state[descFile]
            } catch {}

            try {
                const files = await fs.readdir(backupDir)
                const backups = files.filter(f => f.endsWith("_descript.ion")).sort()
                status.backupCount = backups.length
                status.backups = backups
            } catch {}

            return status
        },

        async restoreBackup(folder, backupFile) {
            if (!folder || !backupFile) throw new Error('Folder and backup file required')
            const resolvedPath = path.resolve(folder)
            const backupDir = path.join(resolvedPath, "cache", "descript_backup")
            const src = path.join(backupDir, backupFile)
            const dst = path.join(resolvedPath, "descript.ion")
            
            try {
                await fs.stat(src)
                await fs.copyFile(src, dst)
                const hash = await getFileHash(dst)
                if (hash) {
                    state[dst] = hash
                    await saveState()
                }
                return `Restored: ${backupFile}`
            } catch (e) {
                api.log("Restore error:", e)
                throw e
            }
        }
    }
}