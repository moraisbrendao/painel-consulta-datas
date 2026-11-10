Attribute VB_Name = "ExportarPainel"
' =====================================================================
' Exportar para o painel
' Gera o arquivo "painel_entregas.csv" (na mesma pasta da planilha)
' somente com os pedidos marcados como "Novo retorno" na aba Retornos
' (coluna "Situacao semanal"). Os detalhes do pedido (nota, canal,
' previsao original, rastreio) vem da aba Pedidos.
' Pedidos com "Status Transportador" Entregue ou Cancelado na aba
' Intelipost ficam de fora. Antes de exportar, cole na aba Intelipost
' a base nova (transactions_....xlsx) baixada da Intelipost.
' Depois e so enviar esse arquivo no painel.
'
' Como instalar (uma vez): Alt+F11 > Arquivo > Importar arquivo >
' escolha este ExportarPainel.bas. Depois crie um botao na planilha
' (Desenvolvedor > Inserir > Botao) e associe a macro ExportarParaPainel.
' Se ja tinha a versao antiga: no Alt+F11, clique com o botao direito
' em "ExportarPainel" > Remover, e importe esta de novo.
' =====================================================================
Option Explicit

Private Const SITUACAO_FILTRO As String = "Novo retorno"

Public Sub ExportarParaPainel()
    Dim wsP As Worksheet, wsR As Worksheet
    Set wsP = ThisWorkbook.Worksheets("Pedidos")
    Set wsR = ThisWorkbook.Worksheets("Retornos")

    Application.ScreenUpdating = False
    Application.StatusBar = "Exportando para o painel..."

    ' ---- 1) Aba Pedidos: guarda a linha de cada pedido ----
    Dim cPed&, cCanalPed&, cNota&, cCanal&, cTransp&, cStatus&, cPrevO&, cPrevA&
    Dim cEntrega&, cUF&, cCidade&, cLink&
    cPed = AcharColuna(wsP, "Pedido Intelipost", False)
    cCanalPed = AcharColuna(wsP, "Pedido Anymarket", False)
    cNota = AcharColuna(wsP, "Nota-S" & ChrW(233) & "rie", False)
    cCanal = AcharColuna(wsP, "Canal", False)
    cTransp = AcharColuna(wsP, "Transportadora", False)
    cStatus = AcharColuna(wsP, "Status", False)
    cPrevO = AcharColuna(wsP, "Prev. Original", False)
    cPrevA = AcharColuna(wsP, "Prev. Atual", False)
    cEntrega = AcharColuna(wsP, "Data Entrega", False)
    cUF = AcharColuna(wsP, "UF", False)
    cCidade = AcharColuna(wsP, "Cidade", False)
    cLink = AcharColuna(wsP, "Link Rastreio", False)

    Dim ultP As Long, i As Long, ped As String
    ultP = wsP.Cells(wsP.Rows.Count, cPed).End(xlUp).Row
    Dim d As Variant
    d = wsP.Range(wsP.Cells(1, 1), wsP.Cells(ultP, wsP.Cells(1, wsP.Columns.Count).End(xlToLeft).Column)).Value
    Dim linhaPed As Object: Set linhaPed = CreateObject("Scripting.Dictionary")
    linhaPed.CompareMode = vbTextCompare
    For i = 2 To ultP
        ped = Texto(d(i, cPed))
        If ped <> "" Then linhaPed(ped) = i
    Next i

    ' ---- 2) Aba Retornos: so as linhas "Novo retorno" ----
    Dim rA&, rB&, rC&, rD&, rE&, rG&, rH&
    rA = AcharColuna(wsR, "Pedido Intelipost", False)
    rB = AcharColuna(wsR, "Retorno da ocorrencia", False)
    rC = AcharColuna(wsR, "Transportadora", False)
    rD = AcharColuna(wsR, "Data do retorno", False)
    rE = AcharColuna(wsR, "Situa" & ChrW(231) & "" & ChrW(227) & "o semanal", True)
    rG = AcharColuna(wsR, "Retorno padronizado", True)
    rH = AcharColuna(wsR, "Canal", True)

    Dim ultR As Long
    ultR = wsR.Cells(wsR.Rows.Count, rA).End(xlUp).Row
    Dim r As Variant
    r = wsR.Range(wsR.Cells(1, 1), wsR.Cells(ultR, Application.Max(rA, rB, rC, rD, rE, rG, rH))).Value

    ' se o mesmo pedido aparecer mais de uma vez, fica o retorno mais recente
    Dim escolhido As Object: Set escolhido = CreateObject("Scripting.Dictionary")
    escolhido.CompareMode = vbTextCompare
    Dim ant As Long
    For i = 2 To ultR
        ped = Texto(r(i, rA))
        If ped <> "" And StrComp(Texto(r(i, rE)), SITUACAO_FILTRO, vbTextCompare) = 0 Then
            If escolhido.Exists(ped) Then
                ant = escolhido(ped)
                If IsDate(r(i, rD)) And IsDate(r(ant, rD)) Then
                    If CDate(r(i, rD)) < CDate(r(ant, rD)) Then GoTo proximo
                End If
            End If
            escolhido(ped) = i
        End If
proximo:
    Next i

    ' ---- 3) Aba Intelipost: status do transportador de cada pedido ----
    '      (pedidos Entregues ou Cancelados ficam fora do painel)
    Dim wsI As Worksheet
    Set wsI = ThisWorkbook.Worksheets("Intelipost")
    Dim iPed&, iSt&, ultI As Long, vPed As Variant, vSt As Variant
    iPed = AcharColuna(wsI, "Pedido", False)
    iSt = AcharColuna(wsI, "Status Transportador", False)
    ultI = wsI.Cells(wsI.Rows.Count, iPed).End(xlUp).Row
    vPed = wsI.Range(wsI.Cells(1, iPed), wsI.Cells(ultI, iPed)).Value
    vSt = wsI.Range(wsI.Cells(1, iSt), wsI.Cells(ultI, iSt)).Value
    Dim stIntel As Object: Set stIntel = CreateObject("Scripting.Dictionary")
    stIntel.CompareMode = vbTextCompare
    For i = 2 To ultI
        ped = Texto(vPed(i, 1))
        If ped <> "" Then stIntel(ped) = Texto(vSt(i, 1))
    Next i

    ' ---- 4) Monta o CSV ----
    Dim partes() As String, n As Long, k As Variant, ir As Long, ip As Long
    ReDim partes(0 To escolhido.Count)
    partes(0) = "pedido;pedido_canal;nota;canal;transportadora;status;prev_original;prev_atual;data_entrega;" & _
                "nova_data;retorno;retorno_texto;data_retorno;uf;cidade;link_rastreio"

    Dim padronizado As Variant, novaData As String, retorno As String
    Dim canal As String, transp As String, stTransp As String, foraEntregue As Long
    For Each k In escolhido.Keys
        ped = CStr(k)
        ir = escolhido(k)

        stTransp = ""
        If stIntel.Exists(ped) Then stTransp = stIntel(ped)
        If StrComp(stTransp, "Entregue", vbTextCompare) = 0 Or StrComp(stTransp, "Cancelado", vbTextCompare) = 0 Then
            foraEntregue = foraEntregue + 1
            GoTo proximoPedido
        End If

        padronizado = r(ir, rG)
        novaData = ParaISO(padronizado)
        retorno = ""
        If novaData = "" And Not IsError(padronizado) And VarType(padronizado) <> vbDate Then
            retorno = Texto(padronizado)
        End If

        ip = 0
        If linhaPed.Exists(ped) Then ip = linhaPed(ped)

        If ip > 0 Then
            canal = Texto(d(ip, cCanal))
            transp = Texto(d(ip, cTransp))
        Else
            canal = Texto(r(ir, rH))
            If InStr(1, canal, "aba Pedidos", vbTextCompare) > 0 Then canal = ""
            transp = Texto(r(ir, rC))
        End If

        n = n + 1
        partes(n) = Q(ped) & ";" & Q(DoPedido(d, ip, cCanalPed)) & ";" & Q(DoPedido(d, ip, cNota)) & ";" & _
                    Q(canal) & ";" & Q(transp) & ";" & Q(IIf(stTransp <> "", stTransp, DoPedido(d, ip, cStatus))) & ";" & _
                    DataDoPedido(d, ip, cPrevO) & ";" & DataDoPedido(d, ip, cPrevA) & ";" & DataDoPedido(d, ip, cEntrega) & ";" & _
                    novaData & ";" & Q(retorno) & ";" & Q(Texto(r(ir, rB))) & ";" & ParaISO(r(ir, rD)) & ";" & _
                    Q(DoPedido(d, ip, cUF)) & ";" & Q(DoPedido(d, ip, cCidade)) & ";" & Q(DoPedido(d, ip, cLink))
proximoPedido:
    Next k

    ' ---- 5) Salva em UTF-8 (para manter os acentos) ----
    Dim caminho As String
    caminho = ThisWorkbook.Path & Application.PathSeparator & "painel_entregas.csv"
    Dim st As Object: Set st = CreateObject("ADODB.Stream")
    st.Type = 2: st.Charset = "utf-8": st.Open
    ReDim Preserve partes(0 To n)
    st.WriteText Join(partes, vbCrLf) & vbCrLf
    st.SaveToFile caminho, 2
    st.Close

    Application.StatusBar = False
    Application.ScreenUpdating = True
    MsgBox n & " pedidos com novo retorno exportados." & vbCrLf & _
           foraEntregue & " ficaram de fora por estarem Entregues ou Cancelados na aba Intelipost." & vbCrLf & vbCrLf & _
           "Arquivo: " & caminho & vbCrLf & vbCrLf & _
           "Agora abra o painel, entre com o seu login e clique em ""Enviar planilha"".", _
           vbInformation, "Exportar para o painel"
End Sub

' Procura o cabecalho na linha 1 (primeira ocorrencia).
' parcial = True aceita o nome como comeco do cabecalho.
Private Function AcharColuna(ByVal ws As Worksheet, ByVal nome As String, ByVal parcial As Boolean) As Long
    Dim c As Range
    Set c = ws.Rows(1).Find(What:=IIf(parcial, nome & "*", nome), LookIn:=xlValues, _
                            LookAt:=xlWhole, MatchCase:=False, SearchOrder:=xlByColumns, _
                            SearchDirection:=xlNext, After:=ws.Cells(1, ws.Columns.Count))
    If c Is Nothing Then
        Err.Raise vbObjectError + 1, , "N" & ChrW(227) & "o achei a coluna """ & nome & """ na aba " & ws.Name & "."
    End If
    AcharColuna = c.Column
End Function

Private Function DoPedido(ByVal d As Variant, ByVal ip As Long, ByVal col As Long) As String
    If ip > 0 Then DoPedido = Texto(d(ip, col))
End Function

Private Function DataDoPedido(ByVal d As Variant, ByVal ip As Long, ByVal col As Long) As String
    If ip > 0 Then DataDoPedido = ParaISO(d(ip, col))
End Function

' Converte data (ou texto dd/mm/aaaa) para aaaa-mm-dd; senao devolve ""
Private Function ParaISO(ByVal v As Variant) As String
    Dim s As String
    If IsError(v) Or IsEmpty(v) Then Exit Function
    If VarType(v) = vbDate Then
        If CDbl(v) >= 1 Then ParaISO = Format$(v, "yyyy-mm-dd")
        Exit Function
    End If
    s = Trim$(CStr(v))
    If s Like "##/##/####" Then
        ParaISO = Mid$(s, 7, 4) & "-" & Mid$(s, 4, 2) & "-" & Left$(s, 2)
    End If
End Function

' Texto da celula (data vira dd/mm/aaaa; erro vira vazio)
Private Function Texto(ByVal v As Variant) As String
    If IsError(v) Or IsEmpty(v) Then Exit Function
    If VarType(v) = vbDate Then
        If CDbl(v) >= 1 Then Texto = Format$(v, "dd/mm/yyyy")
    Else
        Texto = Trim$(CStr(v))
    End If
End Function

' Coloca o texto entre aspas para o CSV
Private Function Q(ByVal v As Variant) As String
    Dim s As String
    s = Replace(Replace(CStr(v), vbCr, " "), vbLf, " ")
    Q = """" & Replace(s, """", """""") & """"
End Function
