'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');

function restoreInstructions(root, directory, platform) {
  const ps = value => "'" + value.replace(/'/g, "''") + "'";
  const sh = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const steps = ['Close Flowkit Studio and its backend before using the restored data.',
    'The current data directory was not changed. Keep this folder to preserve your restored data.'];
  const commands = platform === 'win32'
    ? `$env:FLOW_AGENT_DIR = ${ps(directory)}\n& ${ps(path.win32.join(root, 'start_desktop.bat'))}`
    : `cd ${sh(path.join(root, 'desktop'))}\nFLOW_AGENT_DIR=${sh(directory)} npm start`;
  return steps.join('\n') + '\n\n' + (platform === 'win32' ? 'Run these commands in PowerShell:\n' : 'Run these commands in a terminal:\n') + commands;
}

module.exports = function registerMaintenance({handle, dialog, getWindow, root, base, request, saveResponse, fetch, getOutput,
  platform = process.platform, env = process.env, adapters = {}}) {
  const io = adapters.fs || fs;
  const execute = adapters.execFile || promisify(execFile);
  const now = adapters.now || (() => new Date());
  const paths = platform === 'win32' ? path.win32 : path;
  const python = env.FLOWKIT_PYTHON || paths.join(root, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let restoring = false;

  handle('maintenance-save-backup', async id => {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw Error('Invalid backup ID.');
    const status = await request('GET', '/api/maintenance/backups/' + id);
    if (status.state !== 'COMPLETED')throw Error('Backup is not ready to export.');
    const destination = await dialog.showSaveDialog(getWindow(), {title:'Save Studio backup',
      defaultPath:paths.join(getOutput(), `flowkit-backup-${id}.zip`), filters:[{name:'Studio backup ZIP', extensions:['zip']}]});
    if (destination.canceled || !destination.filePath)return {canceled:true};
    const response = await fetch(`${base}/api/maintenance/backups/${id}/file`, {signal:AbortSignal.timeout(7200000)});
    if (!response.ok)throw Error('Backup file could not be downloaded: HTTP ' + response.status);
    if ((response.headers.get('content-type') || '').split(';')[0] !== 'application/zip') {
      await response.body?.cancel();throw Error('Backend did not return a backup ZIP.');
    }
    await saveResponse(response, destination.filePath);
    return {canceled:false, path:destination.filePath};
  });

  handle('maintenance-restore', async () => {
    if (restoring)throw Error('A restore is already running.');
    restoring = true;
    try {
      const source = await dialog.showOpenDialog(getWindow(), {title:'Choose Studio backup',properties:['openFile'],filters:[{name:'Studio backup ZIP',extensions:['zip']}]});
      if (source.canceled || !source.filePaths?.length)return {canceled:true};
      const archive = source.filePaths[0];
      if (paths.extname(archive).toLowerCase() !== '.zip' || !(await io.stat(archive)).isFile())throw Error('Choose a Studio backup ZIP file.');
      const selected = await dialog.showOpenDialog(getWindow(), {title:'Choose parent folder for restored data (a new folder will be created)',properties:['openDirectory','createDirectory']});
      if (selected.canceled || !selected.filePaths?.length)return {canceled:true};
      const suffix = now().toISOString().replace(/[-:]/g,'').replace('T','-').replace(/\.\d+Z$/,'');
      const target = paths.join(selected.filePaths[0], 'flowkit-restored-' + suffix + '-' + require('node:crypto').randomBytes(3).toString('hex'));
      try {await io.access(python);}catch {throw Error('Studio Python was not found. Run setup_desktop.bat, then retry the restore.');}
      let stdout;
      try {
        ({stdout} = await execute(python, ['-m','agent.services.studio_backup','restore',archive,target],
          {cwd:root,env:{...env},shell:false,windowsHide:true,timeout:7200000,maxBuffer:2*1024*1024}));
      } catch (error) {
        let message = String(error.stderr || error.message || 'Restore failed.').trim();
        try {message = JSON.parse(message).error || message;}catch {}
        throw Error(message.slice(0,3000));
      }
      let result;
      try {result = JSON.parse(stdout);}catch {throw Error('Restore returned an invalid result. Inspect the chosen parent folder.');}
      if (paths.resolve(result.directory || '') !== paths.resolve(target) || result.launch_env?.FLOW_AGENT_DIR !== result.directory)throw Error('Restore returned an unexpected destination. Inspect the chosen parent folder.');
      const instructions = restoreInstructions(root, result.directory, platform);
      const instructionsPath = paths.join(target, 'START_RESTORED_STUDIO.txt');
      let note='';
      try {await io.writeFile(instructionsPath, instructions, {encoding:'utf8',flag:'wx'});}
      catch {note='Restored data is ready, but startup instructions could not be written. Copy the instructions shown here.';}
      return {...result,canceled:false,instructions,instructions_path:note?null:instructionsPath,note};
    } finally {restoring = false;}
  });
};
module.exports.restoreInstructions = restoreInstructions;
