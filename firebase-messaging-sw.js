// Firebase Cloud Messaging Service Worker
// This file must be at the root of the domain (same level as index.html)

importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.0.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDpjdqGtpRbCb2NHeUBi7ODin8zWQs75fM",
  authDomain: "eweome-41e0f.firebaseapp.com",
  projectId: "eweome-41e0f",
  storageBucket: "eweome-41e0f.firebasestorage.app",
  messagingSenderId: "802792165046",
  appId: "1:802792165046:web:8c547dfe07226ec7386017"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  if (!title) return;
  self.registration.showNotification(title, {
    body: body || '',
    icon: 'https://eweome-41e0f.web.app/icon-192.png',
    data: { url: 'https://eweome-41e0f.web.app' }
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data?.url || 'https://eweome-41e0f.web.app')
  );
});
