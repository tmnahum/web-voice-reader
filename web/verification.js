// The remote browser is rendered as pixels; source scripts never run in this view.
export function verifyCapture(id) {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'verification-dialog';
    dialog.setAttribute('aria-labelledby', 'verification-heading');
    dialog.innerHTML = `<div class="verification-heading"><h2 id="verification-heading">Browser verification</h2><button type="button" data-cancel>Cancel capture</button></div>
      <p data-status role="status">This site needs your help before we can save the page.</p>
      <form data-login hidden><label>Admin password <input type="password" autocomplete="current-password" required></label><button>Unlock browser</button></form>
      <div data-browser hidden><p data-site></p><p>Complete any verification below, then click Capture this page when the content looks ready. This session expires after five minutes. This dedicated browser remembers site data between attempts.</p>
      <button type="button" data-capture>Capture this page</button>
      <img data-image alt="Live verification browser. Click to interact." tabindex="0" draggable="false">
      <div class="verification-controls"><button type="button" data-key="Tab">Tab</button><button type="button" data-key="Space">Space</button><button type="button" data-key="Enter">Enter</button><button type="button" data-scroll="-600">Scroll up</button><button type="button" data-scroll="600">Scroll down</button>
      <form data-text><label>Challenge answer <input maxlength="200" autocomplete="off"></label><button>Send text</button></form></div></div>`;
    document.body.append(dialog);
    dialog.showModal();
    const base = `/api/admin/verifications/${encodeURIComponent(id)}`;
    const status = dialog.querySelector('[data-status]');
    const login = dialog.querySelector('[data-login]');
    const browser = dialog.querySelector('[data-browser]');
    const img = dialog.querySelector('[data-image]');
    let done = false, timer, imageUrl, busy = false;
    const previousTitle = document.title;
    document.title = 'Verification needed — Voicesite';
    async function request(path, options) {
      const response = await fetch(path, options);
      if (!response.ok) {
        const result = await response.json();
        const error = new Error(result.error || 'Verification request failed.');
        error.status = response.status;
        throw error;
      }
      return response;
    }
    function finish(error) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      dialog.close(); dialog.remove(); document.title = previousTitle;
      if (error) reject(error); else resolve();
    }
    const post = (path, body) => request(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    async function cancel() {
      void post(`${base}/cancel`, {}).catch(() => {});
      finish(new Error('Capture cancelled.'));
    }
    dialog.querySelector('[data-cancel]').onclick = cancel;
    dialog.addEventListener('cancel', event => { event.preventDefault(); void cancel(); });
    dialog.querySelector('[data-capture]').onclick = async () => {
      const button = dialog.querySelector('[data-capture]');
      button.disabled = true;
      try { await post(`${base}/capture`, {}); }
      catch (error) { status.textContent = error.message; button.disabled = false; }
    };
    async function poll() {
      if (done) return;
      try {
        const state = await (await request(base)).json();
        if (done) return;
        if (state.status === 'ready') return finish();
        if (state.status !== 'waiting') return finish(new Error(state.error || 'The browser session ended before the page could be saved. Try saving again.'));
        login.hidden = true; browser.hidden = false;
        status.textContent = state.error || (state.captureRequested ? 'Capturing this page…' : 'When the content looks ready, click Capture this page.');
        dialog.querySelector('[data-capture]').disabled = !!state.captureRequested;
        dialog.querySelector('[data-site]').textContent = state.url;
        const image = await request(`${base}/image`);
        const blob = await image.blob();
        if (done) return;
        const old = imageUrl; imageUrl = URL.createObjectURL(blob); img.src = imageUrl;
        if (old) URL.revokeObjectURL(old);
      } catch (error) {
        if (done) return;
        if (error.status === 401) {
          login.hidden = false; browser.hidden = true;
          status.textContent = 'Enter the admin password to view and control the verification browser.';
          return;
        }
        if (error.status === 404) return finish(error);
        status.textContent = error.message;
      }
      if (!done) timer = setTimeout(poll, 500);
    }
    login.onsubmit = async event => {
      event.preventDefault();
      try {
        await post('/api/admin/login', {password:login.querySelector('input').value});
        login.reset(); void poll();
      } catch (error) { status.textContent = error.message; }
    };
    // Serialize press/release events. Coalesce only unsent pointer movement.
    const actions = [];
    async function input(action) {
      if (done) return;
      if (action.type === 'move' && actions.at(-1)?.type === 'move') actions[actions.length - 1] = action;
      else if (action.type === 'up' || actions.length < 32) actions.push(action);
      if (busy) return;
      busy = true;
      try {
        while (actions.length && !done) await post(`${base}/input`, actions.shift());
      } catch (error) { actions.length = 0; status.textContent = error.message; }
      finally { busy = false; }
    }
    function point(event) {
      const rect = img.getBoundingClientRect();
      const width = img.naturalWidth || 1280, height = img.naturalHeight || 900;
      return {x:Math.max(0,Math.min(width-1,(event.clientX - rect.left) * width / rect.width)), y:Math.max(0,Math.min(height-1,(event.clientY - rect.top) * height / rect.height))};
    }
    let pressed = false, lastMove = 0;
    img.onpointermove = event => {
      if (performance.now() - lastMove < 60) return;
      lastMove = performance.now();
      void input({type:'move', ...point(event)});
    };
    img.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); img.focus();
      pressed = true; img.setPointerCapture(event.pointerId);
      void input({type:'down', ...point(event)});
    };
    const release = event => {
      if (!pressed) return;
      pressed = false;
      void input({type:'up', ...point(event)});
    };
    img.onpointerup = release;
    img.onpointercancel = release;
    img.onlostpointercapture = release;
    img.onwheel = event => {
      event.preventDefault();
      void input({type:'scroll',deltaY:Math.max(-900,Math.min(900,event.deltaY))});
    };
    img.onkeydown = event => {
      if (['Enter',' ','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) {
        event.preventDefault(); void input({type:'key', key:event.key === ' ' ? 'Space' : event.key});
      }
    };
    for (const button of dialog.querySelectorAll('[data-key]')) button.onclick = () => input({type:'key',key:button.dataset.key});
    for (const button of dialog.querySelectorAll('[data-scroll]')) button.onclick = () => input({type:'scroll',deltaY:Number(button.dataset.scroll)});
    dialog.querySelector('[data-text]').onsubmit = event => {
      event.preventDefault();
      const field = event.target.querySelector('input');
      void input({type:'text',text:field.value}); field.value = '';
    };
    void poll();
  });
}
