'use strict';
(() => {
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const controllers=new WeakMap();
  const textOf=cell=>cell?.querySelector('select')?.selectedOptions[0]?.textContent || cell?.textContent || '';
  function jobRow(content,fields,key,state){
    const row=el('tr');Object.assign(row.dataset,content.dataset);row.dataset.key=key;row.dataset.state=state||'';
    for(const value of fields){const cell=el('td');if(value instanceof Node)cell.append(value);else cell.textContent=value??'—';row.append(cell);}
    const details=el('details'),summary=el('summary','Details / log');details.append(summary);
    const actions=el('td');actions.className='table-actions';
    for(const button of [...content.querySelectorAll('button')])actions.append(button);
    details.append(...content.childNodes);if(window.studioPopups){const log=el('button','Details / log');log.type='button';log.onclick=()=>window.studioPopups.log(String(fields[0]||'Job')+' · '+(state||''),details.textContent.replace(/^Details \/ log/,''));actions.append(log);}else actions.append(details);row.append(actions);return row;
  }
  function snapshot(row){return (row._record||'')+'|'+(row._tableRawHTML||row.outerHTML)+'|'+[...row.querySelectorAll('input,select,textarea')].map(n=>[n.value,n.checked,n.disabled].join(':')).join('|');}
  // Retain unchanged row nodes, event handlers and focus during background polling.
  function reconcile(body,fragment){
    const viewport=body.closest('.table-wrap'),top=viewport?.scrollTop,left=viewport?.scrollLeft;
    const key=r=>r.dataset.rowId||r.dataset.segmentId||r.dataset.key;
    const old=new Map([...body.children].map(r=>[key(r),r]));
    const focused=document.activeElement,focusKey=key(focused?.closest('tr')||{dataset:{}}),focusLabel=focused?.getAttribute('aria-label');
    const keep=new Set();let previous=null;
    for(const fresh of [...fragment.children]){
      const existing=old.get(key(fresh));
      const row=existing&&snapshot(existing)===snapshot(fresh)?existing:fresh;keep.add(row);
      const next=previous?previous.nextSibling:body.firstChild;if(next!==row)body.insertBefore(row,next);previous=row;
    }
    for(const row of [...body.children])if(!keep.has(row))row.remove();
    controllers.get(body.closest('table'))?.apply();
    if(focused&&document.activeElement!==focused&&focusKey&&focusLabel){
      const row=[...body.children].find(r=>key(r)===focusKey);
      [...row?.querySelectorAll('[aria-label]')||[]].find(n=>n.getAttribute('aria-label')===focusLabel)?.focus({preventScroll:true});
    }
    if(viewport){viewport.scrollTop=top;viewport.scrollLeft=left;}
  }
  function enhance(table,{search=true}={}){
    if(controllers.has(table)||!table.tBodies[0]||!table.tHead)return;
    const body=table.tBodies[0],headers=[...table.tHead.rows[0].cells];
    const key='flowkit-table-v1:'+body.id;let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}');}catch{}
    let sort=Number.isInteger(saved.sort)?saved.sort:-1,descending=!!saved.descending;
    const hidden=new Set(Array.isArray(saved.hidden)?saved.hidden.filter(i=>i>0&&i<headers.length-1):[]);
    const controls=el('div');controls.className='data-table-tools';
    const input=el('input');input.type='search';input.placeholder='Search this table…';input.setAttribute('aria-label','Search '+body.id);
    if(search)controls.append(input);
    const columns=el('details');columns.className='table-columns';columns.append(el('summary','Columns'));
    const menu=el('div');menu.className='table-column-menu';columns.append(menu);
    const count=el('span');count.className='muted';count.setAttribute('aria-live','polite');
    const reset=el('button','Reset view');reset.type='button';controls.append(count,columns,reset);
    const wrap=table.closest('.table-wrap')||table;wrap.before(controls);table.classList.add('data-table');
    const defaults=body.id==='sb-rows'?[54,65,140,250,90,150,300,145,160]:body.id==='scb-rows'?[60,145,100,220,280,165,180,195]:[];
    const widths=Array.isArray(saved.widths)?saved.widths:defaults;
    const colgroup=el('colgroup');headers.forEach((_,i)=>{const col=el('col');if(Number.isFinite(widths[i]))col.style.width=Math.max(60,Math.min(800,widths[i]))+'px';colgroup.append(col);});table.prepend(colgroup);table.style.setProperty('--select-column-width',colgroup.children[0]?.style.width||'60px');
    const persist=()=>{try{localStorage.setItem(key,JSON.stringify({sort,descending,hidden:[...hidden],widths:[...colgroup.children].map(c=>parseFloat(c.style.width)||null)}));}catch{}};
    const checkboxes=[];
    headers.forEach((th,i)=>{
      const title=th.textContent.trim()||th.querySelector('input')?.getAttribute('aria-label')||'Column '+(i+1);
      if(!th.querySelector('input')&&!/^(Select|Actions|Activity|Files|Progress)/.test(title)){
        const b=el('button',title);b.type='button';b.className='table-sort';b.title='Sort by '+title;
        th.replaceChildren(b);b.onclick=()=>{descending=sort===i?!descending:false;sort=i;apply();persist();};
      }
      const label=el('label'),box=el('input');box.type='checkbox';box.checked=!hidden.has(i);box.disabled=i===0||i===headers.length-1;checkboxes.push(box);label.append(box,document.createTextNode(title));menu.append(label);
      box.onchange=()=>{box.checked?hidden.delete(i):hidden.add(i);apply();persist();};
      const resize=el('span');resize.className='column-resize';resize.setAttribute('role','separator');resize.setAttribute('aria-label','Resize '+title);resize.setAttribute('aria-orientation','vertical');resize.tabIndex=0;th.append(resize);
      const setWidth=w=>{colgroup.children[i].style.width=Math.max(60,Math.min(800,w))+'px';if(i===0)table.style.setProperty('--select-column-width',colgroup.children[i].style.width);};
      resize.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();setWidth(th.getBoundingClientRect().width+(e.key==='ArrowLeft'?-20:20));persist();}};
      resize.onpointerdown=e=>{e.preventDefault();const x=e.clientX,width=th.getBoundingClientRect().width;resize.setPointerCapture?.(e.pointerId);resize.onpointermove=event=>setWidth(width+event.clientX-x);resize.onpointerup=()=>{resize.onpointermove=null;persist();};};
    });
    let applying=false;
    const observer=new MutationObserver(()=>apply());
    function apply(){
      if(applying)return;applying=true;observer.disconnect();
      const query=input.value.trim().toLocaleLowerCase(),rows=[...body.rows];
      if(/Actions|Activity/.test(headers.at(-1)?.textContent||''))for(const row of rows)window.studioPopups?.compact(row);
      const ordered=sort<0?rows:rows.slice().sort((a,b)=>{
        if(a.cells.length!==headers.length||b.cells.length!==headers.length)return 0;
        return textOf(a.cells[sort]).localeCompare(textOf(b.cells[sort]),undefined,{numeric:true,sensitivity:'base'})*(descending?-1:1);
      });
      let previous=null;for(const row of ordered){const next=previous?previous.nextSibling:body.firstChild;if(row!==next)body.insertBefore(row,next);previous=row;}
      for(const row of rows){row.hidden=!!query&&!row.textContent.toLocaleLowerCase().includes(query);if(row.cells.length===headers.length)for(const [i,cell] of [...row.cells].entries())cell.hidden=hidden.has(i);}
      headers.forEach((h,i)=>{h.hidden=hidden.has(i);h.setAttribute('aria-sort',sort===i?(descending?'descending':'ascending'):'none');});
      count.textContent=rows.length?`${rows.filter(r=>!r.hidden&&r.cells.length===headers.length).length} rows`:'No rows';
      observer.observe(body,{childList:true,subtree:true,characterData:true});applying=false;
    }
    input.oninput=apply;reset.onclick=()=>{sort=-1;descending=false;hidden.clear();input.value='';colgroup.querySelectorAll('col').forEach((c,i)=>c.style.width=defaults[i]?defaults[i]+'px':'');table.style.setProperty('--select-column-width',colgroup.children[0]?.style.width||'60px');if(body.id==='sb-rows'||body.id==='scb-rows')sort=1;checkboxes.forEach(c=>c.checked=true);persist();apply();};
    controllers.set(table,{apply});apply();
  }
  window.studioTables={jobRow,reconcile,enhance,refresh:table=>controllers.get(table)?.apply()};
})();
