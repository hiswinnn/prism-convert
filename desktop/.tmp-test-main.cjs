const {app,BrowserWindow}=require('electron'); console.log('electron OK, app=', typeof app, 'isPackaged=', app && app.isPackaged); app && app.quit();
