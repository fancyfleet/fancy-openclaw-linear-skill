import { linearGraphQL } from "../client";
import { getIssue, updateIssue } from "../issues";
import {
  listProjects,
  getProjectDetail,
  getProjectIssues,
  attachIssueToProject,
  listMilestones,
  createMilestone,
  attachIssueToMilestone,
  createProject,
  editProject
} from "../projects";
import { findUserByName } from "../issues";

jest.mock("../client", () => ({
  ...jest.requireActual("../client"),
  linearGraphQL: jest.fn()
}));

jest.mock("../issues", () => ({
  getIssue: jest.fn(),
  updateIssue: jest.fn(),
  findUserByName: jest.fn()
}));

jest.mock("../teams", () => ({
  resolveTeamId: jest.fn().mockResolvedValue("team-id-ai")
}));

const mockedGraphQL = linearGraphQL as jest.MockedFunction<typeof linearGraphQL>;
const mockGetIssue = getIssue as jest.MockedFunction<typeof getIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockFindUserByName = findUserByName as unknown as jest.MockedFunction<typeof findUserByName>;

const mockProject = {
  id: "proj-1",
  name: "Test Project",
  description: "A project",
  content: null,
  state: "planned",
  progress: 0.5,
  startDate: null,
  targetDate: "2026-03-01"
};

describe("listProjects", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("returns project nodes", async () => {
    mockedGraphQL.mockResolvedValue({ projects: { nodes: [mockProject] } });
    const projects = await listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("Test Project");
  });
});

describe("getProjectDetail", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("finds project by exact name", async () => {
    mockedGraphQL.mockResolvedValue({
      projects: { nodes: [{ ...mockProject, name: "Alpha" }, { ...mockProject, name: "Beta" }] }
    });
    const project = await getProjectDetail("Alpha");
    expect(project.name).toBe("Alpha");
  });

  it("returns single match when no exact match", async () => {
    mockedGraphQL.mockResolvedValue({
      projects: { nodes: [{ ...mockProject, name: "Alpha Beta" }] }
    });
    const project = await getProjectDetail("alpha");
    expect(project.name).toBe("Alpha Beta");
  });

  it("throws when multiple matches and no exact match", async () => {
    mockedGraphQL.mockResolvedValue({
      projects: { nodes: [{ ...mockProject, name: "Alpha A" }, { ...mockProject, name: "Alpha B" }] }
    });
    await expect(getProjectDetail("alpha")).rejects.toThrow("Could not uniquely resolve");
  });
});

describe("getProjectIssues", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("returns issues for a project", async () => {
    mockedGraphQL.mockResolvedValue({
      issues: {
        nodes: [{ id: "i-1", identifier: "AI-100", title: "Test", projectMilestone: null }]
      }
    });
    const issues = await getProjectIssues("Test");
    expect(issues).toHaveLength(1);
    expect(issues[0].identifier).toBe("AI-100");
  });

  it("maps projectMilestone to milestone", async () => {
    const milestone = { id: "m-1", name: "v1.1", description: null, targetDate: null };
    mockedGraphQL.mockResolvedValue({
      issues: {
        nodes: [{ id: "i-1", identifier: "AI-100", title: "Test", projectMilestone: milestone }]
      }
    });
    const issues = await getProjectIssues("Test");
    expect(issues[0].milestone).toEqual(milestone);
  });

  it("returns empty array when no issues match", async () => {
    mockedGraphQL.mockResolvedValue({ issues: { nodes: [] } });
    const issues = await getProjectIssues("Nonexistent");
    expect(issues).toHaveLength(0);
  });
});

describe("attachIssueToProject", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    mockUpdateIssue.mockReset();
    mockedGraphQL.mockResolvedValue({ projects: { nodes: [mockProject] } });
    mockUpdateIssue.mockResolvedValue({} as any);
  });

  it("finds project and updates issue", async () => {
    await attachIssueToProject("issue-1", "Test Project");
    expect(mockUpdateIssue).toHaveBeenCalledWith("issue-1", { projectId: "proj-1" });
  });
});

describe("listMilestones", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("returns milestones with project names", async () => {
    mockedGraphQL
      .mockResolvedValueOnce({
        team: {
          id: "team-1",
          projects: { nodes: [{ id: "p-1", name: "Project A" }] }
        }
      })
      .mockResolvedValueOnce({
        project: {
          projectMilestones: {
            nodes: [{ id: "m-1", name: "Sprint 1", description: "First sprint", targetDate: "2026-02-01" }]
          }
        }
      });
    const milestones = await listMilestones("team-1");
    expect(milestones).toHaveLength(1);
    expect(milestones[0].name).toBe("Sprint 1");
    expect(milestones[0].projectName).toBe("Project A");
  });

  it("throws when team not found", async () => {
    mockedGraphQL.mockResolvedValue({ team: null });
    await expect(listMilestones("bad-team")).rejects.toThrow("Team not found");
  });
});

describe("createMilestone", () => {
  beforeEach(() => mockedGraphQL.mockReset());

  it("creates milestone via mutation", async () => {
    mockedGraphQL
      .mockResolvedValueOnce({ projects: { nodes: [mockProject] } })
      .mockResolvedValueOnce({
        projectMilestoneCreate: {
          success: true,
          projectMilestone: { id: "m-new", name: "Sprint 2", description: null, targetDate: "2026-03-01" }
        }
      });
    const milestone = await createMilestone("Test Project", "Sprint 2", "2026-03-01");
    expect(milestone.name).toBe("Sprint 2");
  });

  it("throws when mutation fails", async () => {
    mockedGraphQL
      .mockResolvedValueOnce({ projects: { nodes: [mockProject] } })
      .mockResolvedValueOnce({ projectMilestoneCreate: { success: false, projectMilestone: null } });
    await expect(createMilestone("Test Project", "Fail", "2026-03-01")).rejects.toThrow("Failed to create milestone");
  });
});

describe("attachIssueToMilestone", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    mockGetIssue.mockReset();
    mockUpdateIssue.mockReset();
    mockGetIssue.mockResolvedValue({ project: { id: "proj-1", name: "Proj" } } as any);
    mockUpdateIssue.mockResolvedValue({} as any);
  });

  it("finds milestone and updates issue", async () => {
    mockedGraphQL.mockResolvedValue({
      project: {
        projectMilestones: {
          nodes: [{ id: "m-1", name: "Sprint 1", description: null, targetDate: "2026-02-01" }]
        }
      }
    });
    await attachIssueToMilestone("issue-1", "Sprint 1");
    expect(mockUpdateIssue).toHaveBeenCalledWith("issue-1", { projectMilestoneId: "m-1" });
  });

  it("throws when milestone not found", async () => {
    mockedGraphQL.mockResolvedValue({
      project: { projectMilestones: { nodes: [] } }
    });
    await expect(attachIssueToMilestone("issue-1", "Nonexistent")).rejects.toThrow("Milestone not found");
  });

  it("throws when issue has no project", async () => {
    mockGetIssue.mockResolvedValue({ project: null } as any);
    await expect(attachIssueToMilestone("issue-1", "Sprint 1")).rejects.toThrow("not attached to a project");
  });
});

describe("createProject description routing", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    mockFindUserByName.mockReset();
    mockedGraphQL.mockResolvedValueOnce({
      projectCreate: { success: true, project: { id: "p-new", name: "New Project", url: "https://linear.app/test" } }
    });
  });

  it("puts short descriptions in the description field", async () => {
    await createProject("AI", "Test", { description: "Short desc under 255 chars" });
    const input = mockedGraphQL.mock.calls[0][1]!.input as Record<string, unknown>;
    expect(input.description).toBe("Short desc under 255 chars");
    expect(input.content).toBeUndefined();
  });

  it("routes long descriptions to content field and truncates description", async () => {
    const longDesc = "A".repeat(300);
    await createProject("AI", "Test", { description: longDesc });
    const input = mockedGraphQL.mock.calls[0]![1]!.input as Record<string, unknown>;
    expect((input.description as string).length).toBeLessThanOrEqual(255);
    expect(input.content).toBe(longDesc);
  });

  it("routes multi-line descriptions to content field", async () => {
    const multiDesc = "## Title\n\nA short first paragraph\n\n### Details\n\nWith more content " + "x".repeat(200);
    expect(multiDesc.length).toBeGreaterThan(255);
    await createProject("AI", "Test", { description: multiDesc });
    const input = mockedGraphQL.mock.calls[0][1]!.input as Record<string, unknown>;
    expect(input.content).toBe(multiDesc);
    expect(input.description).toBeDefined();
  });
});

describe("editProject description routing", () => {
  beforeEach(() => {
    mockedGraphQL.mockReset();
    mockFindUserByName.mockReset();
    mockedGraphQL.mockResolvedValue({
      projectUpdate: { success: true, project: { id: "proj-1", name: "Test Project", url: "https://linear.app/test" } }
    });
  });

  it("puts short descriptions in the description field", async () => {
    await editProject("proj-1", { description: "Short desc" });
    const input = mockedGraphQL.mock.calls[0][1]!.input as Record<string, unknown>;
    expect(input.description).toBe("Short desc");
    expect(input.content).toBeUndefined();
  });

  it("routes long descriptions to content field", async () => {
    const longDesc = "B".repeat(300);
    await editProject("proj-1", { description: longDesc });
    const input = mockedGraphQL.mock.calls[0][1]!.input as Record<string, unknown>;
    expect((input.description as string).length).toBeLessThanOrEqual(255);
    expect(input.content).toBe(longDesc);
  });

  it("routes multi-line descriptions to content field", async () => {
    const multiDesc = "Line one\nLine two\nLine three\n\nMore stuff " + "padding ".repeat(50);
    expect(multiDesc.length).toBeGreaterThan(255);
    await editProject("proj-1", { description: multiDesc });
    const input = mockedGraphQL.mock.calls[0][1]!.input as Record<string, unknown>;
    expect(input.content).toBe(multiDesc);
    expect(input.description).toBeDefined();
  });
});
