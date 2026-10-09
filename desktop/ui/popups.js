'use strict';
(() => {
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  let activeMenu=null;
  function modal(content,title,{canClose=()=>true,onClose=()=>{}}={}){
    const dialog=node('dialog');dialog.className='studio-popup';dialog.setAttribute('aria-label',title);
    const head=node('div');head.className='popup-header';head.append(node('h2',title));
    const close=node('button','Close');close.type='button';head.append(close);
    const feedback=node('p');feedback.className='popup-feedback';feedback.setAttribute('role','status');
    dialog.append(head,content,feedback);document.body.append(dialog);let opener;
    const hide=(force=false)=>{if(!force&&!canClose())return;if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');onClose();if(opener?.isConnected)opener.focus({preventScroll:true});};
    close.onclick=()=>hide();dialog.addEventListener('cancel',e=>{e.preventDefault();hide();});
    dialog.addEventListener('keydown',e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();hide();}
      if(e.key==='Tab'){
        const list=[...dialog.querySelectorAll('button,input,textarea,select,a[href]')].filter(n=>!n.disabled&&!n.closest('[hidden]')&&n.type!=='hidden');
        const first=list[0],last=list.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
      }
    });
    return {dialog,feedback,close:hide,open:()=>{activeMenu?.close();opener=document.activeElement;feedback.textContent='';if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}(content.querySelector('input,textarea,select')||close).focus({preventScroll:true});}};
  }
  // Move existing action buttons, retaining their handlers and disabled states.
  function compact(row){
    const cell=row.cells?.[row.cells.length-1];if(!cell||cell.querySelector('.row-more'))return;
    const buttons=[...cell.querySelectorAll('button')];
    if(buttons.length<3)return;
    const keep=buttons.filter(b=>/^(Select project|Selected|Select video|Edit|View|Preview|Play|Retry row)/.test(b.textContent.trim())).slice(0,2);
    if(!keep.length)keep.push(buttons[0]);
    const extras=buttons.filter(b=>!keep.includes(b));if(!extras.length)return;
    row._tableRawHTML=row.outerHTML;
    const toggle=node('button','⋯');toggle.type='button';toggle.className='row-more';toggle.setAttribute('aria-label','More actions');toggle.setAttribute('aria-expanded','false');
    const menu=node('div');menu.className='row-action-menu';menu.setAttribute('popover','auto');menu.hidden=true;
    for(const b of extras)menu.append(b);cell.append(toggle,menu);
    const close=(focus=false)=>{if(!menu.hidden&&typeof menu.hidePopover==='function')try{menu.hidePopover();}catch{}menu.hidden=true;toggle.setAttribute('aria-expanded','false');if(activeMenu?.menu===menu)activeMenu=null;if(focus&&toggle.isConnected)toggle.focus({preventScroll:true});};
    toggle.onclick=()=>{
      if(!menu.hidden){close(true);return;}activeMenu?.close();
      menu.hidden=false;if(typeof menu.showPopover==='function')menu.showPopover();
      const rect=toggle.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(rect.right-230,innerWidth-246))+'px';menu.style.top=Math.max(8,Math.min(rect.bottom+5,innerHeight-menu.offsetHeight-8))+'px';
      toggle.setAttribute('aria-expanded','true');activeMenu={menu,close};menu.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
    };
    menu.addEventListener('toggle',e=>{if(e.newState==='closed')close();});
    menu.addEventListener('click',e=>{if(e.target.closest('button'))close();});
    menu.addEventListener('keydown',e=>{const list=[...menu.querySelectorAll('button:not(:disabled)')],i=list.indexOf(document.activeElement);if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true);}else if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();list[(i+(e.key==='ArrowDown'?1:-1)+list.length)%list.length]?.focus();}});
  }
  document.addEventListener('pointerdown',e=>{if(activeMenu&&!activeMenu.menu.contains(e.target)&&!e.target.closest('.row-more'))activeMenu.close();});
  document.addEventListener('scroll',()=>activeMenu?.close(),true);
  document.addEventListener('workflow-changed',()=>activeMenu?.close());
  window.addEventListener('resize',()=>activeMenu?.close());
  function log(title,text){
    const content=node('div'),pre=node('pre',text),copy=node('button','Copy log');copy.type='button';pre.tabIndex=0;content.append(pre,copy);
    const popup=modal(content,title,{onClose:()=>popup.dialog.remove()});
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(text);popup.feedback.textContent='Log copied.';}catch{const range=document.createRange();range.selectNodeContents(pre);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);popup.feedback.textContent='Press Ctrl+C to copy the selected log.';}};
    popup.open();
  }
  window.studioPopups={modal,compact,log};
})();
