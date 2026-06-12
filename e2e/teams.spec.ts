/**
 * E2E team management flow.
 *
 * Requirements covered:
 *   - 12.1 — create team
 *   - 12.2 — invite member by email
 *   - 12.3 — change member role
 *   - 12.4 — remove member
 *
 * Skips when the API is not reachable (Task 22.1).
 */
import { expect, test } from '@playwright/test';

import { loginExisting, register } from './helpers/auth.js';
import {
  API_BASE_URL,
  TEST_PASSWORD,
  skipIfStackDown,
  uniqueEmail,
} from './helpers/stack.js';

test.describe('teams', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    await skipIfStackDown(request, testInfo);
    test.skip(
      !process.env.FL_E2E_EMAIL || !process.env.FL_E2E_PASSWORD,
      'Set FL_E2E_EMAIL + FL_E2E_PASSWORD to a verified seed account to run this suite.',
    );
  });

  test('create team, invite member, change role, remove member', async ({ request }) => {
    const { session } = await loginExisting(
      request,
      process.env.FL_E2E_EMAIL!,
      process.env.FL_E2E_PASSWORD!,
    );

    // --- Create team ---
    const teamName = `e2e-team-${Date.now()}`;
    const createRes = await request.post(`${API_BASE_URL}/api/v1/teams`, {
      headers: session.mutatingHeaders(),
      data: { name: teamName },
    });
    expect(createRes.status()).toBe(201);
    const { team } = await createRes.json();
    expect(team.id).toBeTruthy();
    expect(team.name).toBe(teamName);

    // Verify team appears in list
    const listRes = await request.get(`${API_BASE_URL}/api/v1/teams`);
    expect(listRes.ok()).toBe(true);
    const { teams } = await listRes.json();
    expect(teams.some((t: { id: string }) => t.id === team.id)).toBe(true);

    // --- Invite member by email ---
    const memberEmail = uniqueEmail('team-member');
    // Register the member so the invite can resolve to a user
    await register(request, memberEmail, TEST_PASSWORD, 'Team Member');

    const inviteRes = await request.post(
      `${API_BASE_URL}/api/v1/teams/${team.id}/invite`,
      {
        headers: session.mutatingHeaders(),
        data: { email: memberEmail },
      },
    );
    // Accept 200 or 201 depending on implementation
    expect(inviteRes.ok()).toBe(true);
    const inviteBody = await inviteRes.json();
    const memberId = inviteBody.member?.userId ?? inviteBody.member?.id;
    expect(memberId).toBeTruthy();

    // --- Change member role ---
    const roleRes = await request.put(
      `${API_BASE_URL}/api/v1/teams/${team.id}/members/${memberId}`,
      {
        headers: session.mutatingHeaders(),
        data: { role: 'admin' },
      },
    );
    expect(roleRes.ok()).toBe(true);
    const { member: updatedMember } = await roleRes.json();
    expect(updatedMember.role).toBe('admin');

    // --- Remove member ---
    const removeRes = await request.delete(
      `${API_BASE_URL}/api/v1/teams/${team.id}/members/${memberId}`,
      { headers: session.mutatingHeaders() },
    );
    expect(removeRes.ok()).toBe(true);

    // Cleanup: delete team (best-effort, no assertion needed)
    await request.delete(`${API_BASE_URL}/api/v1/teams/${team.id}`, {
      headers: session.mutatingHeaders(),
    });
  });
});
