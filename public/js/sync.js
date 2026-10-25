// WebSocket 连接，断线自动重连
export function createSync(onMessage, onOpen) {
  let ws = null;
  let retry = 0;
  const queue = [];

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      onOpen?.();
      while (queue.length) ws.send(queue.shift());
    };
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
    };
    ws.onclose = () => {
      setTimeout(connect, Math.min(10000, 1000 * 2 ** retry++));
    };
  }
  connect();

  return {
    send(msg) {
      const text = JSON.stringify(msg);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(text);
      else if (msg.type !== 'cursor' && msg.type !== 'view') queue.push(text);
    },
  };
}

export function throttle(fn, wait) {
  let last = 0;
  let timer = null;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    const remain = wait - (Date.now() - last);
    if (remain <= 0) {
      last = Date.now();
      fn(...lastArgs);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...lastArgs);
      }, remain);
    }
  };
}
