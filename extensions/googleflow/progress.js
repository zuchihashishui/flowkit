/* Read-only Desktop progress. RPC acknowledgements are not completed media. */
(() => {
  const root = document.getElementById('flow-progress');
  if (!root) return;
  const labels = {
    QUEUED: 'Queued', PAUSED: 'Queue paused', WAITING_CONNECTION: 'Waiting for bridge', COOLDOWN: 'Waiting for cooldown',
    STARTING: 'Starting', GENERATING_IMAGE: 'Submitting / generating image', SUBMITTING_VIDEO: 'Submitting video',
    GENERATING_VIDEO: 'Generating video · polling', DOWNLOADING: 'Downloading / verifying file',
    COMPLETED: 'Saved to disk', FAILED: 'Failed', NEEDS_REVIEW: 'Needs review', CANCELLED: 'Cancelled',
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const seconds = value => Math.max(0, Math.ceil(Number(value) || 0));
  let refreshing = false;
  function render(data) {
    if (!data || data.error) {
      root.innerHTML = `<strong>Desktop media queue</strong><p class="flow-warning">${escape(data?.error || 'No backend response. Start Flowkit Studio.')}</p>`;
      return;
    }
    const throttle = data.generation_throttle || {};
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    const cooldown = throttle.cooldown_active
      ? `<p class="flow-warning">Cooldown: ${seconds(throttle.cooldown_remaining_s)}s · new generation submissions are held.</p>` : '';
    root.innerHTML = `<strong>Desktop media queue${data.paused ? ' · PAUSED' : ''}</strong>
      <div class="flow-counts"><span>${escape(data.active)} / ${escape(data.max_concurrent)} active</span><span>${escape(data.queued)} queued</span><span>${escape(data.completed)} saved</span><span>${escape(data.failed)} need attention</span></div>
      <p class="flow-hint">Min ${escape(throttle.min_interval_s)}s between submits · up to ${escape(throttle.max_concurrent)} generation RPCs · ${escape(data.rpc_in_flight ?? 0)} RPCs in flight</p>
      ${cooldown}
      <p class="flow-hint">Jobs overlap in one Flow tab. RPC returned ≠ file saved. Active jobs finish when the queue is paused.</p>
      <div class="flow-jobs">${jobs.slice(0, 12).map(job => {
        const active = ['RUNNING', 'SUBMITTING', 'DOWNLOADING'].includes(job.state);
        const elapsed = job.started ? seconds(((active ? Date.now() / 1000 : job.updated) - job.started)) : null;
        return `<article class="flow-job"><div><strong>${escape(job.label || job.id.slice(0, 8))}</strong><span>${escape(job.kind)}${elapsed !== null ? ` · ${elapsed}s` : ''}</span></div>
          <p>${escape(labels[job.stage] || job.stage || job.state)}</p><small>${escape(job.id.slice(0, 8))}${job.error ? ` · ${escape(job.error)}` : ''}</small></article>`;
      }).join('') || '<p class="flow-hint">No Desktop image/video jobs yet.</p>'}</div>`;
  }
  function refresh() {
    if (refreshing) return;
    refreshing = true;
    chrome.runtime.sendMessage({type: 'FLOW_PROGRESS'}, data => {
      refreshing = false;
      render(chrome.runtime.lastError ? {error: chrome.runtime.lastError.message} : data);
    });
  }
  refresh();
  const timer = setInterval(refresh, 2000);
  window.addEventListener('unload', () => clearInterval(timer), {once: true});
})();
