import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MovingMap } from './moving-map';

describe('MovingMap Component', () => {
  let component: MovingMap;
  let fixture: ComponentFixture<MovingMap>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MovingMap],
    }).compileComponents();

    fixture = TestBed.createComponent(MovingMap);
    component = fixture.componentInstance;
  });

  it('creates successfully', () => {
    expect(component).toBeTruthy();
  });
});
