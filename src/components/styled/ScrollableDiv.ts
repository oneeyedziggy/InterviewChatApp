import { styled } from 'styled-components';

export const ScrollableDiv = styled.div<{
  $flexDirection?: string;
  $padding?: string;
}>`
  display: flex;
  border: 1px solid #000;
  padding: ${(props) => props.$padding || '15px'};
  overflow-y: auto;
  flex: 1 1 auto;
  flex-direction: ${(props) => props.$flexDirection || 'column'};
`;
