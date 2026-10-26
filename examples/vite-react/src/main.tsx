import { createEventKit, localStorageSession } from '@eventkit/sdk';
import { EventKitProvider } from '@eventkit/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const ek = createEventKit({
  apiUrl: import.meta.env.VITE_EVENTKIT_API_URL,
  apiKey: import.meta.env.VITE_EVENTKIT_API_KEY,
  eventId: import.meta.env.VITE_EVENTKIT_EVENT_ID,
  session: localStorageSession(),
});

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <EventKitProvider client={ek}>
      <App />
    </EventKitProvider>
  </QueryClientProvider>,
);
