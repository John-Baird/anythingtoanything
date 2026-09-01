import { bootstrapApplication } from '@angular/platform-browser';
import { Home } from './app/pages/home/home';

bootstrapApplication(Home).catch((err) => console.error(err));
