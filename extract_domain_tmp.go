package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
)

type handler struct { event, arg, method string }

func main() {
	path := "socket_handlers.go"
	source, err := os.ReadFile(path); if err != nil { panic(err) }
	fset := token.NewFileSet(); file, err := parser.ParseFile(fset, path, source, parser.ParseComments); if err != nil { panic(err) }
	targets := []handler{
		{event: "EventClientNewRoom", arg: "roomName", method: "handleNewRoom"},
		{event: "EventClientRequestRoomData", arg: "data", method: "handleRequestRoomData"},
		{event: "EventClientRequestRoomWindow", arg: "data", method: "handleRequestRoomWindow"},
		{event: "EventClientLeaveRoom", arg: "leaveData", method: "handleLeaveRoom"},
		{event: "EventClientRejoinRoom", arg: "rejoinData", method: "handleRejoinRoom"},
	}
	var methods strings.Builder
	for _, target := range targets {
		var call *ast.CallExpr; var literal *ast.FuncLit
		ast.Inspect(file, func(node ast.Node) bool {
			candidate, ok := node.(*ast.CallExpr); if !ok || len(candidate.Args) != 2 { return true }
			selector, ok := candidate.Fun.(*ast.SelectorExpr); if !ok || selector.Sel.Name != "OnEvent" { return true }
			event, ok := candidate.Args[0].(*ast.Ident); if !ok || event.Name != target.event { return true }
			candidateLiteral, ok := candidate.Args[1].(*ast.FuncLit); if !ok { return true }
			call, literal = candidate, candidateLiteral; return false
		})
		if call == nil || literal == nil { panic("handler not found: " + target.event) }
		start := fset.Position(call.Pos()).Offset; end := fset.Position(call.End()).Offset
		bodyStart := fset.Position(literal.Body.Lbrace).Offset + 1; bodyEnd := fset.Position(literal.Body.Rbrace).Offset
		body := strings.ReplaceAll(string(source[bodyStart:bodyEnd]), target.arg, "data")
		methods.WriteString("\nfunc (cs *ChatServer) "); methods.WriteString(target.method); methods.WriteString("(socket wsrt.ServerSocket, data interface{}, defaultNsp *wsrt.Namespace) {")
		if !strings.Contains(body, "socketIDStr :=") { methods.WriteString("\n\tsocketIDStr := string(socket.ID())") }
		methods.WriteString(body); methods.WriteString("\n}\n")
		replacement := fmt.Sprintf("socket.OnEvent(%s, func(%s interface{}) { cs.%s(socket, %s, defaultNsp) })", target.event, target.arg, target.method, target.arg)
		source = append(append([]byte{}, source[:start]...), append([]byte(replacement), source[end:]...)...)
		file, err = parser.ParseFile(fset, path, source, parser.ParseComments); if err != nil { panic(err) }
	}
	filePath := "socket_handlers_rooms.go"
	content := []byte("package main\n\nimport (\n\t\"fmt\"\n\t\"log\"\n\t\"strconv\"\n\t\"strings\"\n\t\"time\"\n\n\twsrt \"chat-server-go/websocket\"\n\n\t\"github.com/google/uuid\"\n)\n")
	if existing, err := os.ReadFile(filePath); err == nil { content = existing }
	content = append(content, []byte(methods.String())...)
	if err := os.WriteFile(filePath, content, 0644); err != nil { panic(err) }
	if err := os.WriteFile(path, source, 0644); err != nil { panic(err) }
}
