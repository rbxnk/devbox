import { render } from 'preact';
import { App } from './app.tsx';
import './style.css';

render(<App />, document.getElementById('app')!);
if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('/sw.js');
