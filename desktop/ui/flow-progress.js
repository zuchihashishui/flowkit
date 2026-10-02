(() => {
 'use strict';
 const $ = id => document.getElementById(id); let refreshing = false;
 async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
   const data = await window.studio.api('GET', '/api/desktop/flow-progress');
   const throttle = data.generation_throttle || {};
   $('flow-activity-summary').textContent = `${data.paused ? 'Queue paused' : 'Queue running'} · ${data.active || 0}/${data.max_concurrent || 3} media slots active · ${data.queued || 0} queued · ${data.completed || 0} completed · ${data.failed || 0} failed · Submit interval: ${throttle.min_interval_s ?? 3}s${throttle.cooldown_active ? ' · Cooldown: ' + Math.ceil(throttle.cooldown_remaining_s || 0) + 's' : throttle.next_submit_remaining_s > 0 ? ' · Next submission in ' + Math.ceil(throttle.next_submit_remaining_s) + 's' : ''}`;
   $('flow-activity-jobs').replaceChildren(...(data.jobs || []).map(job => {
    const row = document.createElement('div'); row.className = 'item';
    const title = document.createElement('strong'); title.textContent = `${job.label || job.id} · ${job.kind}`;
    const state = document.createElement('p'); state.textContent = `${job.state} · ${(job.stage || job.state).replaceAll('_', ' ')}${job.started && ['RUNNING', 'SUBMITTING', 'DOWNLOADING'].includes(job.state) ? ' · ' + Math.max(0, Math.round(Date.now() / 1000 - job.started)) + 's elapsed' : ''}`;
    row.append(title, state); if (job.error) { const error = document.createElement('small'); error.textContent = job.error; row.append(error); } return row;
   }));
  } catch (e) { $('flow-activity-summary').textContent = 'Flow activity unavailable: ' + e.message; }
  finally { refreshing = false; }
 }
 document.querySelector('[data-page="queue"]').addEventListener('click', refresh);
 setInterval(() => { if (!document.querySelector('[data-view="queue"]').hidden) refresh(); }, 3000);
})();
