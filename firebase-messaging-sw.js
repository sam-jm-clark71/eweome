importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyDpjdqGtpRbCb2NHeUBi7ODin8zWQs75fM",
  authDomain:        "eweome-41e0f.firebaseapp.com",
  projectId:         "eweome-41e0f",
  storageBucket:     "eweome-41e0f.firebasestorage.app",
  messagingSenderId: "802792165046",
  appId:             "1:802792165046:web:8c547dfe07226ec7386017"
});

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'ewe-o-me', {
    body: body || 'You have a new notification',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: payload.data
  });
});

// Handle notification click
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('eweome') && 'focus' in client) return client.focus();
      }
      return clients.openWindow('https://eweome-41e0f.web.app');
    })
  );
});
