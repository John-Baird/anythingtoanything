import { Component } from '@angular/core';
import { ConvertComponent } from '../../components/convert/convert.component';
import { MatDivider } from '@angular/material/divider';

@Component({
  selector: 'app-home-page',
  imports: [ConvertComponent, MatDivider],
  templateUrl: './home.page.html',
  styleUrl: './home.page.scss',
})
export class HomePage {}
