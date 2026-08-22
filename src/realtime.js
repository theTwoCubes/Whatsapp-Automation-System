// Tracks the console websocket connections and pushes small events so the UI can
// refresh. In process and single instance, which is all we need for now.
export function createRealtime() {
  const clients = new Set();

  return {
    add(socket) {
      clients.add(socket);
      socket.on('close', () => clients.delete(socket));
    },
    emit(event) {
      const data = JSON.stringify(event);
      for (const socket of clients) {
        try {
          socket.send(data);
        } catch {
          clients.delete(socket);
        }
      }
    },
    size() {
      return clients.size;
    },
  };
}
