import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom does no layout, so it has no scrollIntoView; the UI kit calls it to reveal a field error.
if (typeof Element !== 'undefined') Element.prototype.scrollIntoView = () => undefined;

afterEach(cleanup);
