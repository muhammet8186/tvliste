const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1100,
        height: 750,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true // <webview> etiketini aktif eder
        }
    });

    mainWindow.loadFile('index.html');

    // Ağ trafiğini dinleme (Network Interception)
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const url = details.url;
        
        // Video uzantılarını ve akış formatlarını filtrele
        if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.ts') || url.includes('.webm') || url.includes('video/')) {
            console.log("Yakalanan Video Kaynağı:", url);
            
            // Arayüze (index.html) yakalanan linki gönder
            if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send('video-captured', url);
            }
        }
        
        callback({ cancel: false });
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
