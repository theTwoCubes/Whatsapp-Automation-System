import { createContext } from 'react';

export const BrandContext = createContext({
  name: 'Console',
  watermark: '',
  supportEmail: '',
  accentColor: '#00a884',
});
