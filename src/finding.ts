export type Finding = {
  path: string;
  line: number;
  column: number;
  ruleName: string;
  priority: number;
  message: string;
  context: string;
};
