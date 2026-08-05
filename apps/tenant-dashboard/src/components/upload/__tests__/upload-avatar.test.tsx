// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';

import { createAppTheme } from '../../../theme/create-theme';
import UploadAvatar from '../upload-avatar';
import type { UploadProps } from '../types';

// The component reads semantic palette tokens through the `(theme.vars ?? theme)`
// guard; render it under the real cssVariables app theme so those reads resolve.
function renderAvatar(props: UploadProps) {
  return render(
    <ThemeProvider theme={createAppTheme()}>
      <UploadAvatar {...props} />
    </ThemeProvider>,
  );
}

describe('UploadAvatar', () => {
  it('prompts to upload when no file is set', () => {
    renderAvatar({ file: null });
    expect(screen.getByText('Upload photo')).toBeInTheDocument();
    expect(screen.queryByText('Update photo')).not.toBeInTheDocument();
  });

  it('switches to the update prompt and previews the image once a file is set', () => {
    renderAvatar({ file: 'https://cdn.test/avatars/me.png' });

    expect(screen.getByText('Update photo')).toBeInTheDocument();
    expect(screen.queryByText('Upload photo')).not.toBeInTheDocument();

    const preview = screen.getByAltText('avatar') as HTMLImageElement;
    expect(preview.getAttribute('src')).toBe('https://cdn.test/avatars/me.png');
  });

  it('renders caller-supplied helperText', () => {
    renderAvatar({ file: null, helperText: <span>PNG under 3MB</span> });
    expect(screen.getByText('PNG under 3MB')).toBeInTheDocument();
  });
});
