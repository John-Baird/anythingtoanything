import { Component } from '@angular/core';
import { ConvertComponent } from '../../components/convert/convert.component';

@Component({
  selector: 'app-home-page',
  imports: [ConvertComponent],
  templateUrl: './home.page.html',
  styleUrl: './home.page.scss',
})
export class HomePage {}
