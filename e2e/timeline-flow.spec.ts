import { expect, test } from '@playwright/test';

/*
 * Browser + mock-IPC UI flow (ADR-014, docs/ROADMAP.md Phase 4 gate): import -> arrange
 * -> split -> ripple delete -> undo all -> redo all. Drives the real React app in a
 * plain Chromium tab against the Vite dev server; every Tauri command is answered by
 * e2e/mock-ipc.ts instead of the Rust core (see e2e/mock-app.html).
 */

test('import, arrange, split, ripple delete, undo all, redo all', async ({ page }) => {
  await page.goto('/e2e/mock-app.html');
  await expect(page.getByTestId('app-version')).toBeVisible();

  // Import: the mocked dialog "picks" one file, media_import "probes" it successfully.
  await page.getByRole('button', { name: 'Import…' }).click();
  const mediaCard = page.getByTestId('media-card');
  await expect(mediaCard).toHaveCount(1);

  // Arrange: place the (linked video+audio) clip at the end of V1/A1.
  await mediaCard.getByRole('button', { name: 'Add to timeline' }).click();
  const clipBlocks = page.getByTestId('clip-block');
  await expect(clipBlocks).toHaveCount(2);

  // Split at the playhead: click 2s into the 4s clip on the ruler, then press 's'.
  await page.getByTestId('timeline-ruler').click({ position: { x: 200, y: 10 } });
  await page.keyboard.press('s');
  await expect(clipBlocks).toHaveCount(4);

  // Ripple delete: select the second (right-hand) video clip; its linked audio partner
  // is pulled in automatically by the op, and the gap closes on both tracks.
  await clipBlocks.nth(1).click();
  await page.keyboard.press('Shift+Delete');
  await expect(clipBlocks).toHaveCount(2);
  await expect(mediaCard).toHaveCount(1); // the asset itself is untouched

  // Undo all four edits (import, arrange, split, ripple delete) back to the empty project.
  const undo = page.getByRole('button', { name: 'Undo' });
  for (let i = 0; i < 4; i += 1) {
    await undo.click();
  }
  await expect(clipBlocks).toHaveCount(0);
  await expect(mediaCard).toHaveCount(0);
  await expect(undo).toBeDisabled();

  // Redo all four back to the post-ripple-delete state.
  const redo = page.getByRole('button', { name: 'Redo' });
  for (let i = 0; i < 4; i += 1) {
    await redo.click();
  }
  await expect(clipBlocks).toHaveCount(2);
  await expect(mediaCard).toHaveCount(1);
  await expect(redo).toBeDisabled();
});
