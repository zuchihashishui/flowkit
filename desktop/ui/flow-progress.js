(() => {
 'use strict';
 const $ = id => document.getElementById(id); let refreshing = false;
 const scope=()=>({project_id:$('project-select')?.value||'',video_id:$('video-select')?.value||''});
 const key=s=>s.project_id+'|'+s.video_id;
 let shownScope='';
 async function refresh() {
  const selected=scope(),selectedKey=key(selected);
  if(shownScope!==selectedKey){$('flow-activity-jobs').replaceChildren();$('flow-activity-summary').textContent='Loading selected video…';shownScope=selectedKey;}
  if(!selected.project_id||!selected.video_id){$('flow-activity-summary').textContent='Select a project and video to view Flow activity.';return;}
  if (refreshing) return; refreshing = true;
  try {
   const data = await window.studio.api('GET', '/api/desktop/flow-progress?'+new URLSearchParams(selected));
   if(key(scope())!==selectedKey)return;
   const throttle = data.generation_throttle || {};
   $('flow-activity-summary').textContent = `${data.paused ? 'Queue paused' : 'Queue running'} · ${data.active || 0} active in this video · ${data.queued || 0} queued · ${data.completed || 0} completed · ${data.failed || 0} failed · Submit interval: ${throttle.min_interval_s ?? 3}s${throttle.cooldown_active ? ' · Cooldown: ' + Math.ceil(throttle.cooldown_remaining_s || 0) + 's' : throttle.next_submit_remaining_s > 0 ? ' · Next submission in ' + Math.ceil(throttle.next_submit_remaining_s) + 's' : ''}`;
   $('flow-activity-jobs').replaceChildren(...(data.jobs || []).map(job => {
    const row = document.createElement('div'); row.className = 'item';
    const title = document.createElement('strong'); title.textContent = `${job.label || job.id} · ${job.kind}`;
    const state = document.createElement('p'); state.textContent = `${job.state} · ${(job.stage || job.state).replaceAll('_', ' ')}${job.started && ['RUNNING', 'SUBMITTING', 'DOWNLOADING'].includes(job.state) ? ' · ' + Math.max(0, Math.round(Date.now() / 1000 - job.started)) + 's elapsed' : ''}`;
    row.append(title, state); if (job.error) { const error = document.createElement('small'); error.textContent = job.error; row.append(error); } return row;
   }));
  } catch (e) { if(key(scope())!==selectedKey)return; $('flow-activity-summary').textContent = 'Flow activity unavailable: ' + e.message; }
  finally { refreshing = false; if(key(scope())!==selectedKey)refresh(); }
 }
<<<<<<< HEAD
 for(const id of ['project-select','video-select'])$(id)?.addEventListener('change',refresh);
 for(const name of ['project-changed','production-updated'])document.addEventListener(name,refresh);
=======
>>>>>>> ae804f6f6558557cae163f49f007427697ddd2af
 document.querySelector('[data-page="scene-board"]').addEventListener('click', refresh);
 setInterval(() => { if (!document.querySelector('[data-view="scene-board"]').hidden) refresh(); }, 3000);
})();
