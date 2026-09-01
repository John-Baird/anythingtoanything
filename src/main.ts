import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { HomePage } from './app/pages/home/home.page';

bootstrapApplication(HomePage, {
  providers: [provideHttpClient()],
}).catch((err) => console.error(err));
