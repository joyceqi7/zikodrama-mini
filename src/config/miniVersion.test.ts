import { expect, it } from 'vitest';
import { miniAppVersion } from './miniVersion';

it('业务版本为随包三段数字，与 Git 构建标识分开',()=>{
  expect(miniAppVersion()).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
});
