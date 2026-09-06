import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PIP_GEOMETRY,
  MAX_PIP_GEOMETRY,
  MIN_PIP_GEOMETRY,
  parsePipGeometry,
} from '../../src/floatpanel/pip-geometry';

describe('parsePipGeometry', () => {
  it('restores a valid persisted content size', () => {
    expect(parsePipGeometry({ width: 512.4, height: 721.6 })).toEqual({
      width: 512,
      height: 722,
    });
  });

  it('clamps persisted dimensions to the supported content range', () => {
    expect(parsePipGeometry({ width: 1, height: 9_999 })).toEqual({
      width: MIN_PIP_GEOMETRY.width,
      height: MAX_PIP_GEOMETRY.height,
    });
    expect(parsePipGeometry({
      width: MAX_PIP_GEOMETRY.width + 1,
      height: MIN_PIP_GEOMETRY.height - 1,
    })).toEqual({
      width: MAX_PIP_GEOMETRY.width,
      height: MIN_PIP_GEOMETRY.height,
    });
  });

  it('falls back per dimension when persisted values are invalid', () => {
    expect(parsePipGeometry({ width: Number.NaN, height: '600' })).toEqual(
      DEFAULT_PIP_GEOMETRY,
    );
  });
});
